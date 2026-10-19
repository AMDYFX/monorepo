import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { InMemoryUserRiskStateStore, PostgresUserRiskStateStore, userRiskStateStore } from './userRiskStateStore.js'
import { NgnWalletService } from '../services/ngnWalletService.js'
import { ngnWalletStore } from './ngnWalletStore.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { getPool, closeDbPools } from '../db.js'

describe('InMemoryUserRiskStateStore - freeze history', () => {
  let store: InMemoryUserRiskStateStore

  beforeEach(() => {
    store = new InMemoryUserRiskStateStore()
  })

  it('records a FROZEN then UNFROZEN event with the acting admin', async () => {
    await store.freeze('user-h1', 'MANUAL', 'suspicious', 'admin-1')
    await store.unfreeze('user-h1', 'cleared', 'admin-2')

    const history = await store.getHistory('user-h1')
    expect(history.map((e) => e.eventType)).toEqual(['FROZEN', 'UNFROZEN'])
    expect(history[0].actorId).toBe('admin-1')
    expect(history[0].freezeReason).toBe('MANUAL')
    expect(history[1].actorId).toBe('admin-2')
  })

  it('records system-initiated freezes with a null actor', async () => {
    await store.freeze('user-h2', 'NEGATIVE_BALANCE', 'deficit')

    const [event] = await store.getHistory('user-h2')
    expect(event.eventType).toBe('FROZEN')
    expect(event.actorId).toBeNull()
  })

  it('keeps history after the current state is unfrozen', async () => {
    await store.freeze('user-h3', 'MANUAL')
    await store.unfreeze('user-h3')

    expect((await store.getByUserId('user-h3'))?.isFrozen).toBe(false)
    expect(await store.getHistory('user-h3')).toHaveLength(2)
  })
})

describe('Freeze state visibility across service instances', () => {
  const userId = 'user-persist-1'

  beforeEach(async () => {
    userRiskStateStore.clear()
    await ngnWalletStore.clear()
  })

  it('a freeze is seen by a new NgnWalletService instance', async () => {
    await userRiskStateStore.freeze(userId, 'MANUAL', 'fraud review')

    // A fresh service instance reads the store, not a cached copy
    const freshService = new NgnWalletService()
    await expect(freshService.requireNotFrozen(userId)).rejects.toMatchObject({
      code: ErrorCode.ACCOUNT_FROZEN,
    })
    await expect(freshService.requireNotFrozen(userId)).rejects.toBeInstanceOf(AppError)
  })

  it('an unfreeze is seen by a new NgnWalletService instance', async () => {
    await userRiskStateStore.freeze(userId, 'MANUAL')
    await userRiskStateStore.unfreeze(userId)

    await expect(new NgnWalletService().requireNotFrozen(userId)).resolves.toBeUndefined()
  })
})

const dbUrl = process.env.DATABASE_URL

describe.skipIf(!dbUrl)('PostgresUserRiskStateStore (requires DATABASE_URL)', () => {
  let store: PostgresUserRiskStateStore

  beforeAll(async () => {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not available')
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), 'migrations', '20261019130000_user_risk_states.sql'),
      'utf8',
    )
    await pool.query(migration)
    store = new PostgresUserRiskStateStore()
  })

  beforeEach(async () => {
    const pool = await getPool()
    await pool!.query('DELETE FROM user_risk_state_events')
    await pool!.query('DELETE FROM user_risk_states')
  })

  afterAll(async () => {
    await closeDbPools()
  })

  it('freezes persist and are visible to a new store instance (restart)', async () => {
    await store.freeze('pg-user-1', 'MANUAL', 'restart test', 'admin-1')

    const restarted = new PostgresUserRiskStateStore()
    const state = await restarted.getByUserId('pg-user-1')
    expect(state?.isFrozen).toBe(true)
    expect(state?.freezeReason).toBe('MANUAL')
    expect(state?.frozenAt).toBeInstanceOf(Date)
  })

  it('records freeze history with actors', async () => {
    await store.freeze('pg-user-2', 'COMPLIANCE', undefined, 'admin-1')
    await store.unfreeze('pg-user-2', 'resolved', 'admin-2')

    const history = await store.getHistory('pg-user-2')
    expect(history.map((e) => e.eventType)).toEqual(['FROZEN', 'UNFROZEN'])
    expect(history[1].actorId).toBe('admin-2')
  })

  it('lists only frozen users', async () => {
    await store.freeze('pg-user-3', 'MANUAL')
    await store.freeze('pg-user-4', 'MANUAL')
    await store.unfreeze('pg-user-4')

    const frozen = await store.getAllFrozen()
    expect(frozen.map((s) => s.userId)).toEqual(['pg-user-3'])
  })
})
