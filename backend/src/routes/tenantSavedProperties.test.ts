import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { randomUUID } from 'node:crypto'

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
}))

vi.mock('../models/listingStore.js', () => ({
  listingStore: { getById: mocks.getById },
}))

import { createTenantSavedPropertiesRouter } from './tenantSavedProperties.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'
import { sessionStore, userStore } from '../models/authStore.js'
import {
  InMemorySavedPropertyStore,
  initSavedPropertyStore,
} from '../models/savedPropertyStore.js'

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

function buildApp(): express.Express {
  const app = express()
  app.use(requestIdMiddleware)
  app.use(express.json())
  app.use('/api/v1/tenant/saved-properties', createTenantSavedPropertiesRouter())
  app.use(errorHandler)
  return app
}

describe('Tenant saved properties (#1889)', () => {
  let app: express.Express
  let tenantToken: string
  let otherToken: string
  let listingId: string

  beforeEach(async () => {
    vi.clearAllMocks()
    initSavedPropertyStore(new InMemorySavedPropertyStore())
    sessionStore.clear()
    userStore.clear()
    mocks.getById.mockResolvedValue({ listingId: 'exists' })

    app = buildApp()
    listingId = randomUUID()

    const tenant = await userStore.getOrCreateByEmail('saved-tenant@example.com')
    tenantToken = 'test-token-saved-tenant'
    await sessionStore.create(tenant.email, tenantToken)

    const other = await userStore.getOrCreateByEmail('saved-other@example.com')
    otherToken = 'test-token-saved-other'
    await sessionStore.create(other.email, otherToken)
  })

  it('requires authentication for every operation', async () => {
    await request(app).get('/api/v1/tenant/saved-properties').expect(401)
    await request(app).post(`/api/v1/tenant/saved-properties/${listingId}`).send({}).expect(401)
    await request(app).delete(`/api/v1/tenant/saved-properties/${listingId}`).expect(401)
  })

  it('returns an empty list before anything is saved', async () => {
    const res = await request(app)
      .get('/api/v1/tenant/saved-properties')
      .set(auth(tenantToken))
      .expect(200)
    expect(res.body).toEqual({ success: true, data: [] })
  })

  it('saves a listing and lists it', async () => {
    const saved = await request(app)
      .post(`/api/v1/tenant/saved-properties/${listingId}`)
      .set(auth(tenantToken))
      .send({})
      .expect(200)
    expect(saved.body).toEqual({ success: true, data: { listingId, saved: true } })

    const listed = await request(app)
      .get('/api/v1/tenant/saved-properties')
      .set(auth(tenantToken))
      .expect(200)
    expect(listed.body.data).toEqual([listingId])
  })

  it('treats a repeated save as a no-op', async () => {
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post(`/api/v1/tenant/saved-properties/${listingId}`)
        .set(auth(tenantToken))
        .send({})
        .expect(200)
    }

    const listed = await request(app)
      .get('/api/v1/tenant/saved-properties')
      .set(auth(tenantToken))
      .expect(200)
    expect(listed.body.data).toEqual([listingId])
  })

  it('returns 404 when saving a listing that does not exist', async () => {
    mocks.getById.mockResolvedValue(null)

    await request(app)
      .post(`/api/v1/tenant/saved-properties/${listingId}`)
      .set(auth(tenantToken))
      .send({})
      .expect(404)

    const listed = await request(app)
      .get('/api/v1/tenant/saved-properties')
      .set(auth(tenantToken))
      .expect(200)
    expect(listed.body.data).toEqual([])
  })

  it('rejects a malformed listing id', async () => {
    await request(app)
      .post('/api/v1/tenant/saved-properties/not-a-uuid')
      .set(auth(tenantToken))
      .send({})
      .expect(400)
    expect(mocks.getById).not.toHaveBeenCalled()
  })

  it('unsaves a listing, and unsaving again is not an error', async () => {
    await request(app)
      .post(`/api/v1/tenant/saved-properties/${listingId}`)
      .set(auth(tenantToken))
      .send({})
      .expect(200)

    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .delete(`/api/v1/tenant/saved-properties/${listingId}`)
        .set(auth(tenantToken))
        .expect(200)
      expect(res.body).toEqual({ success: true, data: { listingId, saved: false } })
    }

    const listed = await request(app)
      .get('/api/v1/tenant/saved-properties')
      .set(auth(tenantToken))
      .expect(200)
    expect(listed.body.data).toEqual([])
  })

  it('lets a listing be unsaved after it has been removed from the catalogue', async () => {
    await request(app)
      .post(`/api/v1/tenant/saved-properties/${listingId}`)
      .set(auth(tenantToken))
      .send({})
      .expect(200)

    mocks.getById.mockResolvedValue(null)
    await request(app)
      .delete(`/api/v1/tenant/saved-properties/${listingId}`)
      .set(auth(tenantToken))
      .expect(200)
  })

  it("keeps each user's saved list private to them", async () => {
    await request(app)
      .post(`/api/v1/tenant/saved-properties/${listingId}`)
      .set(auth(tenantToken))
      .send({})
      .expect(200)

    const otherList = await request(app)
      .get('/api/v1/tenant/saved-properties')
      .set(auth(otherToken))
      .expect(200)
    expect(otherList.body.data).toEqual([])

    // Unsaving someone else's listing does not touch the owner's list.
    await request(app)
      .delete(`/api/v1/tenant/saved-properties/${listingId}`)
      .set(auth(otherToken))
      .expect(200)

    const ownerList = await request(app)
      .get('/api/v1/tenant/saved-properties')
      .set(auth(tenantToken))
      .expect(200)
    expect(ownerList.body.data).toEqual([listingId])
  })
})
