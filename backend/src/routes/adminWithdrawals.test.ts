import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express, { type Express } from 'express'
import { createAdminWithdrawalsRouter } from './adminWithdrawals.js'
import { NgnWalletService } from '../services/ngnWalletService.js'
import { sessionStore, userStore } from '../models/authStore.js'
import { errorHandler } from '../middleware/errorHandler.js'
import { seedNgnWalletFixture } from '../test-fixtures/ngnWalletFixtures.js'

import { getPool } from '../db.js'

describe('Admin Withdrawals Routes', () => {
  let app: Express
  let ngnWalletService: NgnWalletService
  let authToken: string
  let userId: string

  beforeEach(async () => {
    ngnWalletService = new NgnWalletService()

    userStore.clear()
    sessionStore.clear()

    const adminUser = await userStore.getOrCreateByEmail('admin@test.com')
    userId = adminUser.id
    adminUser.role = 'super_admin' // Legacy/test fallback for in-memory store

    // Grant super_admin role in DB for RBAC check
    const pool = await getPool()
    if (pool) {
      await pool.query(`INSERT INTO roles (name, description) VALUES ('super_admin', 'Super admin role') ON CONFLICT (name) DO NOTHING`)
      const { rows: roleRows } = await pool.query(`SELECT id FROM roles WHERE name = 'super_admin'`)
      if (roleRows.length > 0) {
        await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, roleRows[0].id])
      }
    }

    const testToken = `test-token-${Date.now()}`
    const session = await sessionStore.create('admin@test.com', testToken)
    authToken = session.token

    app = express()
    app.use(express.json())
    app.use('/api/admin', createAdminWithdrawalsRouter(ngnWalletService))
    app.use(errorHandler)
  })

  it('should approve a pending withdrawal idempotently', async () => {
    const user = await userStore.getOrCreateByEmail('user1@test.com')
    await seedNgnWalletFixture(user.id)

    const initiated = await ngnWalletService.initiateWithdrawal(user.id, {
      amountNgn: 1000,
      bankAccount: {
        accountNumber: '1234567890',
        accountName: 'Test User',
        bankName: 'Test Bank',
      },
    })

    const first = await request(app)
      .post(`/api/admin/withdrawals/${initiated.id}/approve`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)

    expect(first.body.success).toBe(true)
    expect(first.body.status).toBe('approved')

    const second = await request(app)
      .post(`/api/admin/withdrawals/${initiated.id}/approve`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200)

    expect(second.body.status).toBe('approved')
  })

  it('should reject a pending withdrawal idempotently', async () => {
    const user = await userStore.getOrCreateByEmail('user2@test.com')
    await seedNgnWalletFixture(user.id)

    const initiated = await ngnWalletService.initiateWithdrawal(user.id, {
      amountNgn: 1000,
      bankAccount: {
        accountNumber: '1234567890',
        accountName: 'Test User',
        bankName: 'Test Bank',
      },
    })

    const first = await request(app)
      .post(`/api/admin/withdrawals/${initiated.id}/reject`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reason: 'Risk' })
      .expect(200)

    expect(first.body.success).toBe(true)
    expect(first.body.status).toBe('rejected')

    const second = await request(app)
      .post(`/api/admin/withdrawals/${initiated.id}/reject`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ reason: 'Risk' })
      .expect(200)

    expect(second.body.status).toBe('rejected')
  })
})
