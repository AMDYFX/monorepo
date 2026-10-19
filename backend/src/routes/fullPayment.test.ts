import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { id: req.headers['x-test-user'] ?? 'tenant-1' }
    next()
  },
}))

describe('Full payment preview & confirm (#1961)', () => {
  let app: express.Application
  let dealStore: any
  let settlementLedgerStore: any

  beforeEach(async () => {
    process.env.NODE_ENV = 'test'
    process.env.FULL_PAYMENT_SPLIT_VERSION = 'test-v1'
    process.env.FULL_PAYMENT_PLATFORM_SHARE = '0.1'
    process.env.FULL_PAYMENT_REPORTER_SHARE = '0.05'
    vi.resetModules()

    const { createFullPaymentRouter } = await import('./fullPayment.js')
    const { errorHandler } = await import('../middleware/errorHandler.js')
    const { requestIdMiddleware } = await import('../middleware/requestId.js')
    dealStore = (await import('../models/dealStore.js')).dealStore
    settlementLedgerStore = (await import('../models/settlementLedgerStore.js')).settlementLedgerStore

    await dealStore.clear()
    await settlementLedgerStore.clear()

    app = express()
    app.use(express.json())
    app.use(requestIdMiddleware)
    app.use('/api/payments', createFullPaymentRouter())
    app.use(errorHandler)
  })

  async function seedDeal(tenantId = 'tenant-1') {
    const deal = await dealStore.create({
      tenantId,
      landlordId: 'landlord-1',
      annualRentNgn: 1_200_000,
      depositNgn: 240_000,
      termMonths: 12,
    })
    return deal
  }

  it('returns a bare preview with a payout breakdown', async () => {
    const deal = await seedDeal()

    const res = await request(app)
      .get(`/api/payments/${deal.dealId}/full-payment/preview`)
      .set('x-test-user', 'tenant-1')

    expect(res.status).toBe(200)
    expect(res.body.paymentId).toBe(deal.dealId)
    expect(res.body.breakdown).toMatchObject({
      totalAmount: deal.financedAmountNgn,
      platformShare: Math.round(deal.financedAmountNgn * 0.1),
      reporterShare: null,
      landlordAmount: deal.financedAmountNgn - Math.round(deal.financedAmountNgn * 0.1),
      currency: 'NGN',
    })
    expect(res.body.expiresAt).toBeDefined()
  })

  it('returns 404 for a deal that belongs to another tenant', async () => {
    const deal = await seedDeal('tenant-1')

    const res = await request(app)
      .get(`/api/payments/${deal.dealId}/full-payment/preview`)
      .set('x-test-user', 'tenant-2')
    expect(res.status).toBe(404)
  })

  it('confirms a full payment and writes settlement ledger entries', async () => {
    const deal = await seedDeal()

    const res = await request(app)
      .post(`/api/payments/${deal.dealId}/full-payment/confirm`)
      .set('x-test-user', 'tenant-1')
      .set('x-idempotency-key', 'fp-1')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      paymentId: deal.dealId,
      status: 'confirmed',
    })
    expect(res.body.reference).toContain('FULL-')
    expect(res.body.paidAt).toBeDefined()
    expect(res.body.breakdown.totalAmount).toBe(deal.financedAmountNgn)

    const entries = await settlementLedgerStore.listByDealId(deal.dealId, 'full_payment_incentive')
    expect(entries.some((e: any) => e.beneficiaryType === 'platform')).toBe(true)
    expect(entries.some((e: any) => e.beneficiaryType === 'landlord')).toBe(true)
  })

  it('requires an idempotency key on confirm', async () => {
    const deal = await seedDeal()

    const res = await request(app)
      .post(`/api/payments/${deal.dealId}/full-payment/confirm`)
      .set('x-test-user', 'tenant-1')

    expect(res.status).toBe(400)
  })
})
