import { ngnWalletStore } from '../models/ngnWalletStore.js'

/**
 * Test-only: funds a user's NGN wallet through real ledger entries.
 *
 * Defaults match the balance the old demo seed produced (₦55,000 available
 * top-up, ₦5,000 held for staking) so existing assertions stay valid.
 * Production code never calls this.
 */
export async function seedNgnWalletFixture(
  userId: string,
  { topUpNgn = 55000, heldNgn = 5000 }: { topUpNgn?: number; heldNgn?: number } = {},
): Promise<void> {
  const wallet =
    (await ngnWalletStore.getWalletByUserId(userId)) ??
    (await ngnWalletStore.createWallet(userId))

  await ngnWalletStore.createLedgerEntry({
    walletId: wallet.walletId,
    type: 'TOPUP_CONFIRMED',
    amountNgn: topUpNgn,
    referenceType: 'test-fixture',
    referenceId: `FIXTURE-TOPUP-${userId}`,
  })
  if (heldNgn > 0) {
    await ngnWalletStore.createLedgerEntry({
      walletId: wallet.walletId,
      type: 'STAKE_RESERVE',
      amountNgn: -heldNgn,
      referenceType: 'test-fixture',
      referenceId: `FIXTURE-HELD-${userId}`,
    })
  }
}
