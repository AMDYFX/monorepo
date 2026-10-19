import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createLeaseAgreementsRouter } from './leaseAgreements.js'
import { dealStore } from '../models/dealStore.js'
import { leaseAgreementStore } from '../models/leaseAgreementStore.js'
import { leaseSignatureStore } from '../models/leaseSignatureStore.js'
import { LeaseStatus } from '../models/leaseAgreement.js'
import { computeLeaseDocumentHash } from '../services/leaseDocumentService.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = {
      id: req.headers['x-test-user'] ?? 'tenant-1',
      role: req.headers['x-test-role'] ?? 'tenant',
    }
    next()
  },
}))

describe('lease integrity and signing (#1960)', () => {
  let app: express.Application

  const createDeal = async () =>
    dealStore.create({
      tenantId: 'tenant-1',
      landlordId: 'landlord-1',
      annualRentNgn: 1_200_000,
      depositNgn: 240_000,
      termMonths: 12,
    })

  const createLease = async (dealId: string) => {
    const documentKey = `lease/${dealId}/doc.pdf`
    return leaseAgreementStore.create({
      dealId,
      documentKey,
      documentHash: computeLeaseDocumentHash(documentKey),
    })
  }

  beforeEach(async () => {
    await dealStore.clear()
    await leaseAgreementStore.clear()
    await leaseSignatureStore.clear()

    app = express()
    app.use(express.json())
    app.use(requestIdMiddleware)
    app.use('/api', createLeaseAgreementsRouter())
    app.use(errorHandler)
  })

  it('reports integrity as valid for an untouched document', async () => {
    const deal = await createDeal()
    const lease = await createLease(deal.dealId)

    const res = await request(app)
      .get(`/api/deals/${deal.dealId}/lease/integrity`)
      .set('x-test-user', 'tenant-1')

    expect(res.status).toBe(200)
    expect(res.body.data.valid).toBe(true)
    expect(res.body.data.documentHash).toBe(lease.documentHash)
    expect(res.body.data.documentVersion).toBe('doc.pdf')
  })

  it('reports integrity false and refuses signing when the document is tampered with', async () => {
    const deal = await createDeal()
    const lease = await createLease(deal.dealId)
    await leaseAgreementStore.setDocumentHashForTest(lease.leaseId, 'tampered-hash')

    const integrity = await request(app)
      .get(`/api/deals/${deal.dealId}/lease/integrity`)
      .set('x-test-user', 'tenant-1')
    expect(integrity.status).toBe(200)
    expect(integrity.body.data.valid).toBe(false)

    const sign = await request(app)
      .post(`/api/deals/${deal.dealId}/lease/sign`)
      .set('x-test-user', 'tenant-1')
      .send({ signerName: 'Ada Tenant', signDate: '2026-10-19', acknowledged: true })
    expect(sign.status).toBe(409)
    expect(sign.body.error.code).toBe('CONFLICT')
  })

  it('returns 403 for a non-party and 404 when no lease exists', async () => {
    const deal = await createDeal()
    await createLease(deal.dealId)

    const stranger = await request(app)
      .get(`/api/deals/${deal.dealId}/lease/integrity`)
      .set('x-test-user', 'stranger')
    expect(stranger.status).toBe(403)

    const otherDeal = await createDeal()
    const noLease = await request(app)
      .get(`/api/deals/${otherDeal.dealId}/lease/integrity`)
      .set('x-test-user', 'tenant-1')
    expect(noLease.status).toBe(404)
  })

  it('records a signature and is idempotent per party', async () => {
    const deal = await createDeal()
    await createLease(deal.dealId)

    const first = await request(app)
      .post(`/api/deals/${deal.dealId}/lease/sign`)
      .set('x-test-user', 'tenant-1')
      .send({ signerName: 'Ada Tenant', signDate: '2026-10-19', acknowledged: true })
    expect(first.status).toBe(200)
    expect(first.body.data.leaseId).toBeDefined()

    const second = await request(app)
      .post(`/api/deals/${deal.dealId}/lease/sign`)
      .set('x-test-user', 'tenant-1')
      .send({ signerName: 'Ada Tenant Renamed', signDate: '2026-10-20', acknowledged: true })
    expect(second.status).toBe(200)
    expect(second.body.data.idempotent).toBe(true)
    expect(second.body.data.signedAt).toBe(first.body.data.signedAt)

    const signatures = await leaseSignatureStore.listByDealId(deal.dealId)
    expect(signatures).toHaveLength(1)
  })

  it('marks the lease fully signed once both parties sign', async () => {
    const deal = await createDeal()
    await createLease(deal.dealId)

    await request(app)
      .post(`/api/deals/${deal.dealId}/lease/sign`)
      .set('x-test-user', 'tenant-1')
      .send({ signerName: 'Ada Tenant', signDate: '2026-10-19', acknowledged: true })
      .expect(200)

    const landlordSign = await request(app)
      .post(`/api/deals/${deal.dealId}/lease/sign`)
      .set('x-test-user', 'landlord-1')
      .send({ signerName: 'Bob Landlord', signDate: '2026-10-19', acknowledged: true })
    expect(landlordSign.status).toBe(200)
    expect(landlordSign.body.data.status).toBe(LeaseStatus.FULLY_SIGNED)

    const lease = await leaseAgreementStore.getByDealId(deal.dealId)
    expect(lease?.status).toBe(LeaseStatus.FULLY_SIGNED)
    expect(lease?.tenantSignedAt).toBeDefined()
    expect(lease?.landlordSignedAt).toBeDefined()
  })

  it('rejects signing without acknowledgement', async () => {
    const deal = await createDeal()
    await createLease(deal.dealId)

    const res = await request(app)
      .post(`/api/deals/${deal.dealId}/lease/sign`)
      .set('x-test-user', 'tenant-1')
      .send({ signerName: 'Ada Tenant', signDate: '2026-10-19', acknowledged: false })

    expect(res.status).toBe(400)
  })
})
