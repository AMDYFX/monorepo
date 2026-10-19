import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { Account, Keypair, StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { createVestingRouter, createAdminVestingRouter } from './vesting.js'
import { StubSorobanAdapter } from '../soroban/stub-adapter.js'
import { buildVestingClaimOperation } from '../soroban/vestingClaim.js'
import { InMemoryLinkedAddressStore } from '../models/linkedAddressStore.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { requestIdMiddleware } from '../middleware/requestId.js'

const PASSPHRASE = 'Test SDF Network ; September 2015'
const VESTING_ID = StrKey.encodeContract(Buffer.alloc(32, 9))
const NOW = Math.floor(new Date('2026-10-19T00:00:00Z').getTime() / 1000)

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

describe('Vesting routes (#1911)', () => {
  let adapter: StubSorobanAdapter
  let linked: InMemoryLinkedAddressStore
  let app: express.Express
  let adminToken: string
  let tenantToken: string
  let tenantWallet: Keypair
  let tenantId: string

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW * 1000))

    StubSorobanAdapter._testOnlyReset()
    adapter = new StubSorobanAdapter({
      rpcUrl: 'http://localhost:8000',
      networkPassphrase: PASSPHRASE,
      vestingScheduleId: VESTING_ID,
    })
    linked = new InMemoryLinkedAddressStore()
    sessionStore.clear()
    userStore.clear()

    app = express()
    app.use(requestIdMiddleware)
    app.use(express.json())
    app.use('/api/v1/vesting', createVestingRouter(adapter, linked))
    app.use('/api/v1/admin/vesting', createAdminVestingRouter(adapter))
    app.use(errorHandler)

    const tenant = await userStore.getOrCreateByEmail('vesting-tenant@example.com')
    tenantId = tenant.id
    tenantToken = 'test-token-vesting-tenant'
    await sessionStore.create(tenant.email, tenantToken)
    tenantWallet = Keypair.random()
    await linked.setLinkedAddress(tenantId, tenantWallet.publicKey())

    // requirePermission falls back to the legacy role when no RBAC database is configured.
    const admin = Object.assign(await userStore.getOrCreateByEmail('vesting-admin@example.com'), {
      role: 'admin',
    })
    adminToken = 'test-token-vesting-admin'
    await sessionStore.create(admin.email, adminToken)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Creates a schedule that is half vested at NOW: 1000 tokens over 2000 seconds, cliff already passed. */
  async function createScheduleFor(beneficiary: string, overrides: Record<string, unknown> = {}) {
    return request(app)
      .post('/api/v1/admin/vesting')
      .set(auth(adminToken))
      .send({
        beneficiary,
        totalAmount: '1000',
        startTime: NOW - 1_000,
        cliffTime: NOW - 500,
        endTime: NOW + 1_000,
        revocable: true,
        ...overrides,
      })
  }

  describe('GET /api/v1/vesting/me', () => {
    it('requires authentication', async () => {
      await request(app).get('/api/v1/vesting/me').expect(401)
    })

    it('rejects a user with no linked wallet', async () => {
      const stranger = await userStore.getOrCreateByEmail('vesting-stranger@example.com')
      await sessionStore.create(stranger.email, 'test-token-vesting-stranger')

      const res = await request(app)
        .get('/api/v1/vesting/me')
        .set(auth('test-token-vesting-stranger'))
        .expect(400)
      expect(res.body.error?.message ?? res.body.message).toMatch(/No linked wallet/)
    })

    it('returns the schedule and the claimable amount for the linked wallet', async () => {
      await createScheduleFor(tenantWallet.publicKey()).expect(201)

      const res = await request(app)
        .get('/api/v1/vesting/me')
        .set(auth(tenantToken))
        .expect(200)

      expect(res.body.success).toBe(true)
      expect(res.body.data.beneficiary).toBe(tenantWallet.publicKey())
      expect(res.body.data.schedule).toMatchObject({
        totalAmount: '1000',
        claimedAmount: '0',
        revocable: true,
        revoked: false,
      })
      expect(res.body.data.claimable).toBe('500')
    })

    it('returns a null schedule when none exists', async () => {
      const res = await request(app).get('/api/v1/vesting/me').set(auth(tenantToken)).expect(200)
      expect(res.body.data.schedule).toBeNull()
      expect(res.body.data.claimable).toBe('0')
    })
  })

  describe('claim flow', () => {
    it('prepares, accepts a wallet-signed claim, and then shows nothing left to claim', async () => {
      await createScheduleFor(tenantWallet.publicKey()).expect(201)

      const prepared = await request(app)
        .post('/api/v1/vesting/claim/prepare')
        .set(auth(tenantToken))
        .expect(200)
      const tx = TransactionBuilder.fromXDR(prepared.body.data.xdr, PASSPHRASE) as Transaction
      tx.sign(tenantWallet)

      const submitted = await request(app)
        .post('/api/v1/vesting/claim/submit')
        .set(auth(tenantToken))
        .send({ signedXdr: tx.toXDR() })
        .expect(200)
      expect(submitted.body.data.txHash).toMatch(/claim_vesting/)

      const me = await request(app).get('/api/v1/vesting/me').set(auth(tenantToken)).expect(200)
      expect(me.body.data.schedule.claimedAmount).toBe('500')
      expect(me.body.data.claimable).toBe('0')
    })

    it('refuses to prepare a claim when nothing has vested', async () => {
      const res = await request(app)
        .post('/api/v1/vesting/claim/prepare')
        .set(auth(tenantToken))
        .expect(400)
      expect(res.body.error?.message ?? res.body.message).toMatch(/Nothing vested/)
    })

    it('rejects a signed claim made for a different beneficiary', async () => {
      await createScheduleFor(tenantWallet.publicKey()).expect(201)

      // An intruder builds and signs a claim for their own address, then submits it
      // through the tenant's session. The claim must be rejected.
      const intruder = Keypair.random()
      const forged = new TransactionBuilder(new Account(intruder.publicKey(), '0'), {
        fee: '100',
        networkPassphrase: PASSPHRASE,
      })
        .addOperation(buildVestingClaimOperation(VESTING_ID, intruder.publicKey()))
        .setTimeout(300)
        .build()
      forged.sign(intruder)

      await request(app)
        .post('/api/v1/vesting/claim/submit')
        .set(auth(tenantToken))
        .send({ signedXdr: forged.toXDR() })
        .expect(400)
    })

    it('rejects a submission that is not a transaction envelope', async () => {
      await request(app)
        .post('/api/v1/vesting/claim/submit')
        .set(auth(tenantToken))
        .send({ signedXdr: 'not-xdr' })
        .expect(400)
    })
  })

  describe('admin routes', () => {
    it('requires the vesting:manage permission', async () => {
      const tenant = await userStore.getOrCreateByEmail('vesting-plain@example.com')
      await sessionStore.create(tenant.email, 'test-token-vesting-plain')

      await request(app)
        .post('/api/v1/admin/vesting')
        .set(auth('test-token-vesting-plain'))
        .send({
          beneficiary: tenantWallet.publicKey(),
          totalAmount: '1000',
          startTime: NOW - 1_000,
          cliffTime: NOW - 500,
          endTime: NOW + 1_000,
          revocable: true,
        })
        .expect(403)
    })

    it('creates a schedule', async () => {
      const res = await createScheduleFor(tenantWallet.publicKey()).expect(201)
      expect(res.body.data.beneficiary).toBe(tenantWallet.publicKey())
      expect(res.body.data.txHash).toMatch(/create_vesting/)
    })

    it('rejects invalid schedule times and amounts', async () => {
      await createScheduleFor(tenantWallet.publicKey(), { cliffTime: NOW + 5_000 }).expect(400)
      await createScheduleFor(tenantWallet.publicKey(), { totalAmount: '0' }).expect(400)
      await createScheduleFor(tenantWallet.publicKey(), { totalAmount: 'abc' }).expect(400)
    })

    it('rejects an invalid beneficiary address', async () => {
      await createScheduleFor('GNOTANADDRESS').expect(400)
    })

    it('revokes a revocable schedule', async () => {
      await createScheduleFor(tenantWallet.publicKey()).expect(201)

      const res = await request(app)
        .post(`/api/v1/admin/vesting/${tenantWallet.publicKey()}/revoke`)
        .set(auth(adminToken))
        .expect(200)
      expect(res.body.data.txHash).toMatch(/revoke_vesting/)

      const schedule = await adapter.getVestingSchedule(tenantWallet.publicKey())
      expect(schedule?.revoked).toBe(true)
      expect(await adapter.getClaimableVested(tenantWallet.publicKey())).toBe(0n)
    })
  })
})
