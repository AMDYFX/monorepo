import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createTenantLeaseRouter } from './tenantLease.js'
import { dealStore } from '../models/dealStore.js'
import { listingStore } from '../models/listingStore.js'
import { ListingStatus } from '../models/listing.js'
import { DealStatus } from '../models/deal.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { id: req.headers['x-test-user'] ?? 'tenant-1' }
    next()
  },
}))

describe('Tenant lease endpoints (#1959)', () => {
  let app: express.Application

  beforeEach(async () => {
    await dealStore.clear()
    await listingStore.clear()

    app = express()
    app.use(express.json())
    app.use(requestIdMiddleware)
    app.use('/api', createTenantLeaseRouter())
    app.use(errorHandler)
  })

  async function seedActiveDeal(tenantId = 'tenant-1') {
    const listing = await listingStore.create({
      whistleblowerId: 'wb-1',
      address: '12 Marina Road',
      city: 'Lagos',
      area: 'Lekki',
      bedrooms: 3,
      bathrooms: 2,
      annualRentNgn: 1_200_000,
      photos: [],
    })
    await listingStore.updateStatus(listing.listingId, ListingStatus.APPROVED)

    const deal = await dealStore.create({
      tenantId,
      landlordId: 'landlord-1',
      listingId: listing.listingId,
      annualRentNgn: 1_200_000,
      depositNgn: 240_000,
      termMonths: 12,
    })
    await dealStore.updateStatus(deal.dealId, DealStatus.ACTIVE)
    return deal
  }

  it('returns the current active lease for the tenant', async () => {
    const deal = await seedActiveDeal()

    const res = await request(app)
      .get('/api/tenant/lease/current')
      .set('x-test-user', 'tenant-1')

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.dealId).toBe(deal.dealId)
    expect(res.body.data.property).toBe('12 Marina Road')
    expect(res.body.data.monthlyPayment).toBe(80_000)
    expect(res.body.data.landlord.name).toBeDefined()
  })

  it('returns 404 when the tenant has no active lease', async () => {
    const res = await request(app)
      .get('/api/tenant/lease/current')
      .set('x-test-user', 'tenant-with-nothing')
    expect(res.status).toBe(404)
  })

  it('returns full lease details for an owned deal', async () => {
    const deal = await seedActiveDeal()

    const res = await request(app)
      .get(`/api/tenant/deals/${deal.dealId}/lease`)
      .set('x-test-user', 'tenant-1')

    expect(res.status).toBe(200)
    expect(res.body.data.dealId).toBe(deal.dealId)
    expect(res.body.data.property).toMatchObject({
      title: '12 Marina Road',
      beds: 3,
      baths: 2,
      sqm: 0,
    })
    expect(res.body.data.lease.duration).toBe('12 months')
    expect(res.body.data.lease.monthlyPayment).toBe(80_000)
    expect(res.body.data.landlord).toHaveProperty('email')
    expect(res.body.data.paymentProgress.totalPayments).toBe(12)
  })

  it('hides another tenant\'s deal behind a 404', async () => {
    const deal = await seedActiveDeal('tenant-1')

    const res = await request(app)
      .get(`/api/tenant/deals/${deal.dealId}/lease`)
      .set('x-test-user', 'tenant-2')
    expect(res.status).toBe(404)
  })

  it('lists documents for an owned deal', async () => {
    const deal = await seedActiveDeal()

    const res = await request(app)
      .get(`/api/tenant/deals/${deal.dealId}/documents`)
      .set('x-test-user', 'tenant-1')

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
  })

  it('returns 404 for documents of a foreign deal', async () => {
    const deal = await seedActiveDeal('tenant-1')

    const res = await request(app)
      .get(`/api/tenant/deals/${deal.dealId}/documents`)
      .set('x-test-user', 'tenant-2')
    expect(res.status).toBe(404)
  })
})
