import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createLandlordAnalyticsRouter } from './landlordAnalytics.js'
import { landlordPropertyStore } from '../models/landlordPropertyStore.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = {
      id: req.headers['x-test-user'] ?? 'landlord-1',
      role: req.headers['x-test-role'] ?? 'landlord',
    }
    next()
  },
}))

describe('Landlord analytics endpoint (#1958)', () => {
  let app: express.Application

  beforeEach(async () => {
    await landlordPropertyStore.clear()

    app = express()
    app.use(express.json())
    app.use(requestIdMiddleware)
    app.use('/api', createLandlordAnalyticsRouter())
    app.use(errorHandler)
  })

  it('returns an empty-but-shaped analytics payload for a landlord with no properties', async () => {
    const res = await request(app)
      .get('/api/landlord/analytics')
      .set('x-test-user', 'landlord-1')

    expect(res.status).toBe(200)
    expect(res.body.occupancyTrend).toBeInstanceOf(Array)
    expect(res.body.occupancyTrend).toHaveLength(12)
    expect(res.body.revenueBreakdown).toHaveLength(12)
    expect(res.body.paymentTrends).toEqual([])
    expect(res.body.vacancyMetrics).toEqual({ averageTimeToFill: 0, currentVacancyCount: 0 })
  })

  it('rejects non-landlords with 403', async () => {
    const res = await request(app)
      .get('/api/landlord/analytics')
      .set('x-test-user', 'tenant-1')
      .set('x-test-role', 'tenant')
    expect(res.status).toBe(403)
  })

  it('rejects a window longer than 24 months', async () => {
    const res = await request(app)
      .get('/api/landlord/analytics')
      .query({ startDate: '2020-01-01', endDate: '2026-01-01' })
    expect(res.status).toBe(400)
  })

  it('rejects an inverted date range', async () => {
    const res = await request(app)
      .get('/api/landlord/analytics')
      .query({ startDate: '2026-05-01', endDate: '2026-01-01' })
    expect(res.status).toBe(400)
  })
})
