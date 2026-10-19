import { describe, it, expect, beforeEach } from 'vitest'
import { NgnWalletService } from './ngnWalletService.js'
import { ngnWalletStore } from '../models/ngnWalletStore.js'
import { depositStore } from '../models/depositStore.js'
import { userRiskStateStore } from '../models/userRiskStateStore.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { seedNgnWalletFixture } from '../test-fixtures/ngnWalletFixtures.js'

describe('NgnWalletService - concurrency & balance invariants', () => {
  let service: NgnWalletService
  const userId = 'concurrency-user-1'

  beforeEach(async () => {
    service = new NgnWalletService()
    await ngnWalletStore.clear()
    userRiskStateStore.clear()
    await depositStore.clear()
    await seedNgnWalletFixture(userId)
  })

  it('allows only one concurrent stake reserve when combined amount exceeds available balance', async () => {
    const balance = await service.getBalance(userId)
    const reserveAmount = balance.availableNgn - 1000

    const [first, second] = await Promise.allSettled([
      service.reserveNgnForStaking(userId, 'staking', 'ref-a', reserveAmount),
      service.reserveNgnForStaking(userId, 'staking', 'ref-b', reserveAmount),
    ])

    const successes = [first, second].filter((r) => r.status === 'fulfilled')
    const failures = [first, second].filter((r) => r.status === 'rejected')

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(AppError)
    expect((failures[0] as PromiseRejectedResult).reason.code).toBe(ErrorCode.VALIDATION_ERROR)

    const after = await service.getBalance(userId)
    expect(after.availableNgn).toBeGreaterThanOrEqual(0)
    expect(after.totalNgn).toBeGreaterThanOrEqual(0)
  })

  it('duplicate top-up reference credits exactly once under concurrent creditTopUp', async () => {
    const depositId = 'dep-concurrent-1'
    const reference = 'TOPUP-REF-CONCURRENT'

    const [a, b] = await Promise.all([
      service.creditTopUp(userId, depositId, 12_000, reference),
      service.creditTopUp(userId, depositId, 12_000, reference),
    ])

    const creditedCount = [a, b].filter((r) => r.credited).length
    expect(creditedCount).toBe(1)

    const ledger = await service.getLedger(userId)
    const topups = ledger.entries.filter(
      (e) => e.type === 'TOPUP_CONFIRMED' && e.referenceId === reference,
    )
    expect(topups).toHaveLength(1)
  })

  it('insufficient-funds debit fails cleanly and leaves balance unchanged', async () => {
    const before = await service.getBalance(userId)

    await expect(
      service.reserveNgnForStaking(userId, 'staking', 'too-much', before.availableNgn + 1),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    })

    const after = await service.getBalance(userId)
    expect(after.availableNgn).toBe(before.availableNgn)
    expect(after.totalNgn).toBe(before.totalNgn)
  })

  it('debit racing reversal serializes through wallet lock without negative balance', async () => {
    await service.processTopUp(userId, 20_000, 'TOPUP-RACE-CREDIT')
    await depositStore.confirm({
      depositId: 'dep-race-1',
      userId,
      amountNgn: 20_000,
      provider: 'onramp',
      providerRef: 'ONRAMP-RACE-1',
    })

    const before = await service.getBalance(userId)

    await Promise.all([
      service.processDepositReversal('onramp', 'ONRAMP-RACE-1', 'REV-RACE-1'),
      service.reserveNgnForStaking(userId, 'staking', 'race-ref', 5_000),
    ])

    const after = await service.getBalance(userId)
    expect(after.totalNgn).toBeGreaterThanOrEqual(0)
    expect(after.totalNgn).toBe(before.totalNgn - 20_000)
    expect(after.availableNgn).toBe(before.availableNgn - 20_000 - 5_000)
    expect(after.heldNgn).toBe(before.heldNgn + 5_000)

    const ledger = await service.getLedger(userId)
    const reversals = ledger.entries.filter((e) => e.type === 'TOPUP_REVERSED')
    const reserves = ledger.entries.filter(
      (e) => e.type === 'STAKE_RESERVE' && e.referenceId === 'race-ref',
    )
    expect(reversals).toHaveLength(1)
    expect(reserves).toHaveLength(1)
  })

  it('idempotent stake reserve by reference does not apply twice', async () => {
    const first = await service.reserveNgnForStaking(userId, 'staking', 'idem-ref', 2_000)
    const second = await service.reserveNgnForStaking(userId, 'staking', 'idem-ref', 2_000)

    expect(first.reserved).toBe(true)
    expect(second.reserved).toBe(false)

    const ledger = await service.getLedger(userId)
    const reserves = ledger.entries.filter(
      (e) => e.type === 'STAKE_RESERVE' && e.referenceId === 'idem-ref',
    )
    expect(reserves).toHaveLength(1)
  })
})
