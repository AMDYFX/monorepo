/**
 * One-off repair for the demo ledger rows written by the removed wallet seed
 * (referenceType = 'demo').
 *
 * Usage (from backend/):
 *   npm run db:repair-demo-ledger                 # dry run: report only
 *   npm run db:repair-demo-ledger -- --apply      # write reversing entries
 *
 * Rows are never deleted. With --apply, each demo row gets one reversing
 * entry (referenceType 'demo-repair'). Re-running is safe: repaired rows are
 * skipped. Requires DATABASE_URL, since it reads and writes ngn_ledger_entries.
 */
import { PostgresNgnWalletStore } from '../models/ngnWalletStore.js'
import { repairDemoLedgerEntries } from '../services/demoLedgerRepair.js'

async function main() {
  const apply = process.argv.slice(2).includes('--apply')
  const store = new PostgresNgnWalletStore()

  const result = await repairDemoLedgerEntries(store, { apply })

  for (const item of result.items) {
    process.stdout.write(
      JSON.stringify({
        eventType: 'DEMO_LEDGER_ENTRY',
        entryId: item.entryId,
        walletId: item.walletId,
        originalType: item.originalType,
        originalAmountNgn: item.originalAmountNgn,
        repairType: item.repairType,
        repairAmountNgn: item.repairAmountNgn,
        alreadyRepaired: item.alreadyRepaired,
      }) + '\n',
    )
  }

  process.stdout.write(
    JSON.stringify({
      eventType: 'DEMO_LEDGER_REPAIR_COMPLETED',
      timestamp: new Date().toISOString(),
      dryRun: result.dryRun,
      found: result.found,
      alreadyRepaired: result.alreadyRepaired,
      applied: result.applied,
    }) + '\n',
  )
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + '\n')
  process.exitCode = 1
})
