export interface NgnWallet {
    walletId: string
    userId: string
    currency: 'NGN'
    createdAt: Date
}

export type LedgerEntryType =
    | 'TOPUP_PENDING'
    | 'TOPUP_CONFIRMED'
    | 'TOPUP_REVERSED'
    | 'STAKE_RESERVE'
    | 'STAKE_RELEASE'
    | 'CONVERSION_DEBIT'
    | 'WITHDRAWAL_PENDING'
    | 'WITHDRAWAL_CONFIRMED'
    | 'WITHDRAWAL_FAILED'
    | 'ADJUSTMENT'

/**
 * LedgerEntry represents a single entry in the double-entry ledger.
 * 
 * SIGN RULES for amountNgn:
 * - TOPUP_PENDING: 0 (or original amount, but ignored for balance computation)
 * - TOPUP_CONFIRMED: +X (increases available)
 * - TOPUP_REVERSED: -X (decreases available)
 * - STAKE_RESERVE: -X (decreases available, increases held)
 * - STAKE_RELEASE: +X (increases available, decreases held)
 * - CONVERSION_DEBIT: -X (decreases held)
 * - WITHDRAWAL_PENDING: -X (decreases available, increases held)
 * - WITHDRAWAL_CONFIRMED: -X (decreases held)
 * - WITHDRAWAL_FAILED: +X (increases available, decreases held)
 * - ADJUSTMENT: +/-X (affects available only)
 */
export interface LedgerEntry {
    entryId: string
    walletId: string
    type: LedgerEntryType
    amountNgn: number
    referenceType: string // e.g., 'deposit', 'conversion', 'withdrawal', 'manual'
    referenceId: string
    createdAt: Date
}

export interface NgnBalance {
    availableBalanceNgn: number
    heldBalanceNgn: number
    totalBalanceNgn: number
}

export interface NgnWalletStore {
    createWallet(userId: string): Promise<NgnWallet>
    getWalletByUserId(userId: string): Promise<NgnWallet | null>
    getWalletById(walletId: string): Promise<NgnWallet | null>

    createLedgerEntry(entry: Omit<LedgerEntry, 'entryId' | 'createdAt'>): Promise<LedgerEntry>
    getLedgerEntriesByWalletId(walletId: string): Promise<LedgerEntry[]>
    listLedgerEntriesByReferenceType(referenceType: string): Promise<LedgerEntry[]>
    listWallets(options?: { limit?: number; cursor?: string }): Promise<{ items: NgnWallet[]; nextCursor: string | null }>
    // Concurrency control
    acquireLock(walletId: string): Promise<() => Promise<void>>

    clear(): Promise<void>
}
