import type { LedgerEntry, LedgerEntryType, NgnWalletStore } from '../models/ngnWallet.js'

/** Reference type written by the removed demo seed. */
export const DEMO_REFERENCE_TYPE = 'demo'
/** Reference type for the reversing entries this repair writes. */
export const DEMO_REPAIR_REFERENCE_TYPE = 'demo-repair'

export interface DemoLedgerRepairItem {
  entryId: string
  walletId: string
  originalType: LedgerEntryType
  originalAmountNgn: number
  repairType: LedgerEntryType
  repairAmountNgn: number
  alreadyRepaired: boolean
}

export interface DemoLedgerRepairResult {
  dryRun: boolean
  found: number
  alreadyRepaired: number
  applied: number
  items: DemoLedgerRepairItem[]
}

// Reversal types chosen so the available and held totals both return to their
// pre-demo values. Anything else is reversed as a plain ADJUSTMENT.
const REVERSAL_TYPE: Partial<Record<LedgerEntryType, LedgerEntryType>> = {
  TOPUP_CONFIRMED: 'TOPUP_REVERSED',
  STAKE_RESERVE: 'STAKE_RELEASE',
}

export function reversalFor(entry: Pick<LedgerEntry, 'type' | 'amountNgn'>): {
  type: LedgerEntryType
  amountNgn: number
} {
  return {
    type: REVERSAL_TYPE[entry.type] ?? 'ADJUSTMENT',
    amountNgn: -entry.amountNgn,
  }
}

/**
 * Reports demo ledger entries and, when `apply` is true, writes one reversing
 * entry per demo entry. Rows are never deleted. Each reversal is keyed by the
 * original entryId, so re-running skips entries that were already repaired.
 *
 * Do not run two instances at once: the already-repaired check is made once,
 * before any writes.
 */
export async function repairDemoLedgerEntries(
  store: NgnWalletStore,
  { apply }: { apply: boolean },
): Promise<DemoLedgerRepairResult> {
  const demoEntries = await store.listLedgerEntriesByReferenceType(DEMO_REFERENCE_TYPE)
  const repairs = await store.listLedgerEntriesByReferenceType(DEMO_REPAIR_REFERENCE_TYPE)
  const repairedEntryIds = new Set(repairs.map((r) => r.referenceId))

  const items: DemoLedgerRepairItem[] = demoEntries.map((entry) => {
    const reversal = reversalFor(entry)
    return {
      entryId: entry.entryId,
      walletId: entry.walletId,
      originalType: entry.type,
      originalAmountNgn: entry.amountNgn,
      repairType: reversal.type,
      repairAmountNgn: reversal.amountNgn,
      alreadyRepaired: repairedEntryIds.has(entry.entryId),
    }
  })

  let applied = 0
  if (apply) {
    for (const item of items) {
      if (item.alreadyRepaired) continue
      const release = await store.acquireLock(item.walletId)
      try {
        await store.createLedgerEntry({
          walletId: item.walletId,
          type: item.repairType,
          amountNgn: item.repairAmountNgn,
          referenceType: DEMO_REPAIR_REFERENCE_TYPE,
          referenceId: item.entryId,
        })
        applied += 1
      } finally {
        await release()
      }
    }
  }

  return {
    dryRun: !apply,
    found: items.length,
    alreadyRepaired: items.filter((i) => i.alreadyRepaired).length,
    applied,
    items,
  }
}
