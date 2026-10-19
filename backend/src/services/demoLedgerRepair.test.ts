import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryNgnWalletStore } from '../models/ngnWalletStore.js'
import {
  DEMO_REFERENCE_TYPE,
  DEMO_REPAIR_REFERENCE_TYPE,
  repairDemoLedgerEntries,
  reversalFor,
} from './demoLedgerRepair.js'

describe('repairDemoLedgerEntries', () => {
  let store: InMemoryNgnWalletStore
  let walletId: string

  beforeEach(async () => {
    store = new InMemoryNgnWalletStore()
    const wallet = await store.createWallet('demo-user')
    walletId = wallet.walletId
    // Same rows the removed seed used to write
    await store.createLedgerEntry({
      walletId,
      type: 'TOPUP_CONFIRMED',
      amountNgn: 55000,
      referenceType: DEMO_REFERENCE_TYPE,
      referenceId: 'DEMO-INIT',
    })
    await store.createLedgerEntry({
      walletId,
      type: 'STAKE_RESERVE',
      amountNgn: -5000,
      referenceType: DEMO_REFERENCE_TYPE,
      referenceId: 'DEMO-HELD',
    })
    await store.createLedgerEntry({
      walletId,
      type: 'TOPUP_CONFIRMED',
      amountNgn: 1000,
      referenceType: 'deposit',
      referenceId: 'REAL-1',
    })
  })

  it('reports demo rows in dry-run mode without writing', async () => {
    const result = await repairDemoLedgerEntries(store, { apply: false })

    expect(result.dryRun).toBe(true)
    expect(result.found).toBe(2)
    expect(result.applied).toBe(0)
    expect(await store.listLedgerEntriesByReferenceType(DEMO_REPAIR_REFERENCE_TYPE)).toHaveLength(0)
  })

  it('writes one reversing entry per demo row with --apply, and keeps originals', async () => {
    const result = await repairDemoLedgerEntries(store, { apply: true })

    expect(result.applied).toBe(2)
    const repairs = await store.listLedgerEntriesByReferenceType(DEMO_REPAIR_REFERENCE_TYPE)
    expect(repairs).toHaveLength(2)
    expect(await store.listLedgerEntriesByReferenceType(DEMO_REFERENCE_TYPE)).toHaveLength(2)
    expect(await store.getLedgerEntriesByWalletId(walletId)).toHaveLength(5)
  })

  it('is idempotent: a second --apply run writes nothing', async () => {
    await repairDemoLedgerEntries(store, { apply: true })
    const second = await repairDemoLedgerEntries(store, { apply: true })

    expect(second.found).toBe(2)
    expect(second.alreadyRepaired).toBe(2)
    expect(second.applied).toBe(0)
    expect(await store.listLedgerEntriesByReferenceType(DEMO_REPAIR_REFERENCE_TYPE)).toHaveLength(2)
  })

  it('reversing entries bring the wallet back to its pre-demo balance', async () => {
    await repairDemoLedgerEntries(store, { apply: true })

    // Same available/held rules as NgnWalletService.getBalance.
    // The only real funds are the 1,000 top-up.
    const entries = await store.getLedgerEntriesByWalletId(walletId)
    const available = entries
      .filter((e) => ['TOPUP_CONFIRMED', 'TOPUP_REVERSED', 'STAKE_RESERVE', 'STAKE_RELEASE', 'ADJUSTMENT'].includes(e.type))
      .reduce((sum, e) => sum + e.amountNgn, 0)
    const held = entries
      .filter((e) => ['STAKE_RESERVE', 'STAKE_RELEASE'].includes(e.type))
      .reduce((sum, e) => sum - e.amountNgn, 0)

    expect(available).toBe(1000)
    expect(held).toBe(0)
  })

  it('maps reversal types so both top-ups and stake reserves unwind correctly', () => {
    expect(reversalFor({ type: 'TOPUP_CONFIRMED', amountNgn: 55000 })).toEqual({
      type: 'TOPUP_REVERSED',
      amountNgn: -55000,
    })
    expect(reversalFor({ type: 'STAKE_RESERVE', amountNgn: -5000 })).toEqual({
      type: 'STAKE_RELEASE',
      amountNgn: 5000,
    })
    expect(reversalFor({ type: 'ADJUSTMENT', amountNgn: 300 })).toEqual({
      type: 'ADJUSTMENT',
      amountNgn: -300,
    })
  })
})
