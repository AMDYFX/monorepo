import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { createRiskRouter } from './risk.js'
import { NgnWalletService } from '../services/ngnWalletService.js'
import { userRiskStateStore } from '../models/userRiskStateStore.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { ngnWalletStore } from '../models/ngnWalletStore.js'
import { errorHandler } from '../middleware/errorHandler.js'

vi.mock('../utils/tokens.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../utils/tokens.js')>()
  return {
    ...mod,
    generateToken: () => `tok-${Math.random().toString(36).slice(2)}`,
  }
})

describe('Risk Routes', () => {
  let app: Express
  let ngnWalletService: NgnWalletService
  let authToken: string
  const email = 'risk@test.com'

  beforeEach(async () => {
    ngnWalletService = new NgnWalletService()
    userRiskStateStore.clear()

    userStore.clear()
    sessionStore.clear()

    const user = await userStore.getOrCreateByEmail(email)
    const token = `test-token-${Date.now()}-${Math.random().toString(36).substring(7)}`
    const session = await sessionStore.create(user.email, token)
    authToken = session.token

    app = express()
    app.use(express.json())
    app.use((req: any, _res, next) => {
      req.requestId = 'test-request-id'
      next()
    })

    app.use('/api/risk', createRiskRouter(ngnWalletService))
    app.use(errorHandler)
  })

  describe('GET /api/risk/state', () => {
    it('should require authentication', async () => {
      await request(app).get('/api/risk/state').expect(401)
    })

    it('should return not frozen with deficit 0 when risk state is absent and balance is non-negative', async () => {
      const res = await request(app)
        .get('/api/risk/state')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200)

      expect(res.body.isFrozen).toBe(false)
      expect(res.body.freezeReason).toBeNull()
      expect(res.body.deficitNgn).toBe(0)
      expect(typeof res.body.updatedAt).toBe('string')

      expect(res.body.notes).toBeUndefined()
      expect(res.body.frozenAt).toBeUndefined()
      expect(res.body.unfrozenAt).toBeUndefined()
    })

    it('should return frozen state and freezeReason without leaking notes', async () => {
      const userId = (await userStore.getByEmail(email))!.id
      await userRiskStateStore.freeze(userId, 'MANUAL', 'Sensitive notes')

      const res = await request(app)
        .get('/api/risk/state')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200)

      expect(res.body.isFrozen).toBe(true)
      expect(res.body.freezeReason).toBe('MANUAL')
      expect(res.body.deficitNgn).toBe(0)

      expect(res.body.notes).toBeUndefined()
    })

    it('should compute deficit when totalNgn is negative and expose NEGATIVE_BALANCE as reason', async () => {
      const userId = (await userStore.getByEmail(email))!.id

      // Seed the ledger directly to produce a negative balance.
      // New wallets start at zero, so a reversal of 100000 drives totalNgn to -100000.
      const wallet = await ngnWalletStore.getWalletByUserId(userId)
        ?? await ngnWalletStore.createWallet(userId)
      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'TOPUP_REVERSED',
        amountNgn: -100000,
        referenceType: 'test',
        referenceId: 'test-negative-seed',
      })

      const res = await request(app)
        .get('/api/risk/state')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200)

      expect(res.body.isFrozen).toBe(true)
      expect(res.body.freezeReason).toBe('NEGATIVE_BALANCE')
      expect(res.body.deficitNgn).toBeGreaterThan(0)
    })
  })
})
