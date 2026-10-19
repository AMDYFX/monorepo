import {
  WithdrawalRequest,
  WithdrawalResponse,
  WithdrawalHistoryResponse,
  NgnBalanceResponse,
  NgnLedgerResponse,
  NgnLedgerEntry
} from '../schemas/ngnWallet.js'
import { logger } from '../utils/logger.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { userRiskStateStore } from '../models/userRiskStateStore.js'
import { ngnDepositStore } from '../models/ngnDepositStore.js'
import { depositStore } from '../models/depositStore.js'
import { getPaymentProvider } from '../payments/index.js'
import { ngnWalletStore } from '../models/ngnWalletStore.js'
import { LedgerEntryType } from '../models/ngnWallet.js'
import { outboxStore } from '../outbox/store.js'
import { TxType } from '../outbox/types.js'

export class NgnWalletService {
  // We keep these for some temporary tracking, but the LEDGER is the source of truth for balance
  private withdrawals: WithdrawalResponse[] = []
  private withdrawalUserIds: Map<string, string> = new Map()
  private bankAccountsByRef: Map<string, { accountNumber: string; accountName: string; bankName: string }> = new Map()
  private creditedDeposits = new Set<string>()
  // When each withdrawal was claimed for payout, used to find stuck payouts
  private payoutStartedAt: Map<string, number> = new Map()

  constructor() {
    this.initializeDemoData()
  }

  private async initializeDemoData() {
    // Demo bank account
    this.bankAccountsByRef.set('ba-demo-1', {
      accountNumber: '1234567890',
      accountName: 'John Doe',
      bankName: 'Guaranty Trust Bank',
    })
  }

  private resolveBankAccount(request: WithdrawalRequest): { accountNumber: string; accountName: string; bankName: string } {
    if (request.bankAccount) {
      return request.bankAccount
    }
    if (request.bankAccountRef) {
      const bankAccount = this.bankAccountsByRef.get(request.bankAccountRef)
      if (!bankAccount) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Unknown bankAccountRef')
      }
      return bankAccount
    }
    throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Either bankAccountRef or bankAccount is required')
  }

  private async getOrCreateWallet(userId: string) {
    // New wallets start empty. Funds must come from a real ledger event
    // (top-up, adjustment) — never from seeded data.
    let wallet = await ngnWalletStore.getWalletByUserId(userId)
    if (!wallet) {
      wallet = await ngnWalletStore.createWallet(userId)
    }
    return wallet
  }

  async getBalance(userId: string): Promise<NgnBalanceResponse> {
    const wallet = await this.getOrCreateWallet(userId)
    const entries = await ngnWalletStore.getLedgerEntriesByWalletId(wallet.walletId)

    let availableNgn = 0
    let heldNgn = 0

    for (const entry of entries) {
      const type = entry.type
      const amount = entry.amountNgn

      // Available Impact
      if ([
        'TOPUP_CONFIRMED',
        'TOPUP_REVERSED',
        'STAKE_RESERVE',
        'STAKE_RELEASE',
        'WITHDRAWAL_PENDING',
        'WITHDRAWAL_FAILED',
        'ADJUSTMENT'
      ].includes(type)) {
        availableNgn += amount
      }

      // Held Impact
      if ([
        'STAKE_RESERVE',
        'STAKE_RELEASE',
        'WITHDRAWAL_PENDING',
        'WITHDRAWAL_FAILED'
      ].includes(type)) {
        heldNgn -= amount
      } else if ([
        'CONVERSION_DEBIT',
        'WITHDRAWAL_CONFIRMED'
      ].includes(type)) {
        heldNgn += amount
      }
    }

    return {
      availableNgn,
      heldNgn,
      totalNgn: availableNgn + heldNgn,
    }
  }

  async isUserFrozen(userId: string): Promise<boolean> {
    const riskState = await userRiskStateStore.getByUserId(userId)
    if (riskState?.isFrozen) return true
    const balance = await this.getBalance(userId)
    return balance.totalNgn < 0
  }

  async requireNotFrozen(userId: string): Promise<void> {
    const frozen = await this.isUserFrozen(userId)
    if (frozen) {
      const balance = await this.getBalance(userId)
      const riskState = await userRiskStateStore.getByUserId(userId)
      let message = 'Account frozen. '
      if (balance.totalNgn < 0) {
        message += `Negative balance: ${balance.totalNgn} NGN. Please top up to continue.`
      } else if (riskState?.freezeReason === 'MANUAL') {
        message += 'Manual freeze by admin. Contact support.'
      } else if (riskState?.freezeReason === 'COMPLIANCE') {
        message += 'Compliance review required. Contact support.'
      }
      throw new AppError(ErrorCode.ACCOUNT_FROZEN, 403, message)
    }
  }

  async processDepositReversal(provider: string, providerRef: string, reversalRef: string): Promise<void> {
    const deposit = await depositStore.getByProviderRef(provider, providerRef)
    if (!deposit) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Original deposit not found')

    if (deposit.reversedAt) return
    await depositStore.markReversed(deposit.depositId, reversalRef)

    const wallet = await this.getOrCreateWallet(deposit.userId)
    const release = await ngnWalletStore.acquireLock(wallet.walletId)
    try {
      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'TOPUP_REVERSED',
        amountNgn: -deposit.amountNgn,
        referenceType: 'deposit',
        referenceId: reversalRef
      })
      this.creditedDeposits.delete(deposit.depositId)

      const balance = await this.getBalance(deposit.userId)
      if (balance.totalNgn < 0) {
        await userRiskStateStore.freeze(deposit.userId, 'NEGATIVE_BALANCE', `Auto-frozen due to deposit reversal. Deficit: ${Math.abs(balance.totalNgn)} NGN`)
      }
    } finally {
      await release()
    }
  }

  async processTopUp(userId: string, amountNgn: number, reference: string): Promise<void> {
    const wallet = await this.getOrCreateWallet(userId)
    const release = await ngnWalletStore.acquireLock(wallet.walletId)
    try {
      const entries = await ngnWalletStore.getLedgerEntriesByWalletId(wallet.walletId)
      const alreadyCredited = entries.some(
        (e) => e.type === 'TOPUP_CONFIRMED' && e.referenceId === reference,
      )
      if (alreadyCredited) {
        return
      }

      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'TOPUP_CONFIRMED',
        amountNgn,
        referenceType: 'deposit',
        referenceId: reference
      })

      // Mirror to rent_wallet contract for on-chain record
      // Note: For MVP, we use userId as the account identifier since NGN wallet
      // doesn't track Stellar addresses. In production, this should be tied to
      // the user's Stellar wallet address from the wallet service.
      try {
        await outboxStore.create({
          txType: TxType.RENT_WALLET_CREDIT,
          source: 'ngn_wallet',
          ref: reference,
          payload: {
            account: `user_${userId}`,
            amount: amountNgn.toString(),
            userId,
          },
        })
      } catch (outboxError) {
        // Log but don't fail the top-up if outbox creation fails
        logger.warn('Failed to create rent wallet credit outbox item', {
          userId,
          amountNgn,
          reference,
          error: outboxError instanceof Error ? outboxError.message : String(outboxError),
        })
      }

      const balance = await this.getBalance(userId)
      const riskState = await userRiskStateStore.getByUserId(userId)
      if (riskState?.isFrozen && riskState.freezeReason === 'NEGATIVE_BALANCE' && balance.totalNgn >= 0) {
        await userRiskStateStore.unfreeze(userId, `Auto-unfrozen after top-up. Balance restored to ${balance.totalNgn} NGN`)
      }
    } finally {
      await release()
    }
  }

  async getLedger(userId: string, options: { limit?: number; cursor?: string } = {}): Promise<NgnLedgerResponse> {
    const wallet = await this.getOrCreateWallet(userId)
    const entries = await ngnWalletStore.getLedgerEntriesByWalletId(wallet.walletId)

    const mappedEntries: NgnLedgerEntry[] = entries.map(e => ({
      entryId: e.entryId,
      walletId: e.walletId,
      type: e.type,
      amountNgn: e.amountNgn,
      referenceType: e.referenceType,
      referenceId: e.referenceId,
      createdAt: e.createdAt.toISOString()
    })).reverse() // Show newest first

    const limit = options.limit || 20
    return {
      entries: mappedEntries.slice(0, limit),
      nextCursor: null
    }
  }

  async recordTopUpPending(depositId: string, amountNgn: number, reference: string): Promise<void> {
    const deposit = await ngnDepositStore.getById(depositId)
    if (!deposit) return
    const wallet = await this.getOrCreateWallet(deposit.userId)
    await ngnWalletStore.createLedgerEntry({
      walletId: wallet.walletId,
      type: 'TOPUP_PENDING',
      amountNgn,
      referenceType: 'deposit',
      referenceId: reference
    })
  }

  async creditTopUp(userId: string, depositId: string, amountNgn: number, reference: string): Promise<{ credited: boolean; newBalance: NgnBalanceResponse }> {
    const wallet = await this.getOrCreateWallet(userId)
    const release = await ngnWalletStore.acquireLock(wallet.walletId)
    try {
      if (this.creditedDeposits.has(depositId)) {
        return { credited: false, newBalance: await this.getBalance(userId) }
      }

      const entries = await ngnWalletStore.getLedgerEntriesByWalletId(wallet.walletId)
      const alreadyCredited = entries.some(
        (e) => e.type === 'TOPUP_CONFIRMED' && e.referenceId === reference,
      )
      if (alreadyCredited) {
        this.creditedDeposits.add(depositId)
        return { credited: false, newBalance: await this.getBalance(userId) }
      }

      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'TOPUP_CONFIRMED',
        amountNgn,
        referenceType: 'deposit',
        referenceId: reference
      })
      this.creditedDeposits.add(depositId)

      // Mirror to rent_wallet contract for on-chain record
      try {
        await outboxStore.create({
          txType: TxType.RENT_WALLET_CREDIT,
          source: 'ngn_wallet',
          ref: reference,
          payload: {
            account: `user_${userId}`,
            amount: amountNgn.toString(),
            userId,
          },
        })
      } catch (outboxError) {
        logger.warn('Failed to create rent wallet credit outbox item', {
          userId,
          amountNgn,
          reference,
          error: outboxError instanceof Error ? outboxError.message : String(outboxError),
        })
      }

      const balance = await this.getBalance(userId)
      const riskState = await userRiskStateStore.getByUserId(userId)
      if (riskState?.isFrozen && riskState.freezeReason === 'NEGATIVE_BALANCE' && balance.totalNgn >= 0) {
        await userRiskStateStore.unfreeze(userId, `Auto-unfrozen after top-up. Balance restored to ${balance.totalNgn} NGN`)
      }

      return { credited: true, newBalance: balance }
    } finally {
      await release()
    }
  }

  async reverseTopUp(userId: string, depositId: string, amountNgn: number, reference: string): Promise<{ reversed: boolean; newBalance: NgnBalanceResponse }> {
    // This is a wrapper for processDepositReversal but uses different params.
    // For MVP, we can just call processTopUp with negative amount if we don't have provider info.
    const wallet = await this.getOrCreateWallet(userId)
    const release = await ngnWalletStore.acquireLock(wallet.walletId)
    try {
      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'TOPUP_REVERSED',
        amountNgn: -amountNgn,
        referenceType: 'deposit',
        referenceId: reference
      })
      this.creditedDeposits.delete(depositId)
      return { reversed: true, newBalance: await this.getBalance(userId) }
    } finally {
      await release()
    }
  }

  async reserveNgnForStaking(userId: string, externalRefSource: string, externalRef: string, amountNgn: number): Promise<{ reserved: boolean; newBalance: NgnBalanceResponse }> {
    const wallet = await this.getOrCreateWallet(userId)
    const release = await ngnWalletStore.acquireLock(wallet.walletId)
    try {
      const entries = await ngnWalletStore.getLedgerEntriesByWalletId(wallet.walletId)
      const alreadyReserved = entries.some(
        (e) =>
          e.type === 'STAKE_RESERVE' &&
          e.referenceType === externalRefSource &&
          e.referenceId === externalRef,
      )
      if (alreadyReserved) {
        return { reserved: false, newBalance: await this.getBalance(userId) }
      }

      const balance = await this.getBalance(userId)
      if (balance.availableNgn < amountNgn) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 409, `Insufficient available balance. Available: ${balance.availableNgn}, Requested: ${amountNgn}`)
      }
      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'STAKE_RESERVE',
        amountNgn: -amountNgn,
        referenceType: externalRefSource,
        referenceId: externalRef
      })
      return { reserved: true, newBalance: await this.getBalance(userId) }
    } finally {
      await release()
    }
  }

  async releaseNgnReserve(userId: string, externalRefSource: string, externalRef: string, amountNgn: number): Promise<{ released: boolean; newBalance: NgnBalanceResponse }> {
    const wallet = await this.getOrCreateWallet(userId)
    const release = await ngnWalletStore.acquireLock(wallet.walletId)
    try {
      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'STAKE_RELEASE',
        amountNgn: amountNgn,
        referenceType: externalRefSource,
        referenceId: externalRef
      })
      return { released: true, newBalance: await this.getBalance(userId) }
    } finally {
      await release()
    }
  }

  async debitNgnForConversion(userId: string, externalRefSource: string, externalRef: string, amountNgn: number): Promise<{ debited: boolean; newBalance: NgnBalanceResponse }> {
    const wallet = await this.getOrCreateWallet(userId)
    const release = await ngnWalletStore.acquireLock(wallet.walletId)
    try {
      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'CONVERSION_DEBIT',
        amountNgn: -amountNgn,
        referenceType: externalRefSource,
        referenceId: externalRef
      })
      return { debited: true, newBalance: await this.getBalance(userId) }
    } finally {
      await release()
    }
  }

  async initiateWithdrawal(userId: string, request: WithdrawalRequest): Promise<WithdrawalResponse> {
    await this.requireNotFrozen(userId)

    const withdrawalId = `wd-${Date.now()}`
    const reference = `WD-${Date.now()}`
    const withdrawal: WithdrawalResponse = {
      id: withdrawalId,
      amountNgn: request.amountNgn,
      status: 'pending',
      bankAccount: this.resolveBankAccount(request),
      reference,
      createdAt: new Date().toISOString(),
      processedAt: null,
      failureReason: null
    }

    const wallet = await this.getOrCreateWallet(userId)
    const release = await ngnWalletStore.acquireLock(wallet.walletId)
    try {
      const balance = await this.getBalance(userId)
      if (request.amountNgn > balance.availableNgn) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, `Insufficient balance. Available: ${balance.availableNgn}, Requested: ${request.amountNgn}`)
      }

      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'WITHDRAWAL_PENDING',
        amountNgn: -request.amountNgn,
        referenceType: 'withdrawal',
        referenceId: withdrawalId
      })
      this.withdrawals.unshift(withdrawal)
      this.withdrawalUserIds.set(withdrawalId, userId)
      return withdrawal
    } finally {
      await release()
    }
  }

  async confirmWithdrawal(withdrawalId: string): Promise<WithdrawalResponse> {
    const withdrawal = this.withdrawals.find(w => w.id === withdrawalId)
    if (!withdrawal) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Withdrawal not found')
    if (withdrawal.status === 'confirmed') return withdrawal

    const userId = this.withdrawalUserIds.get(withdrawalId)!
    const wallet = await this.getOrCreateWallet(userId)
    const release = await ngnWalletStore.acquireLock(wallet.walletId)
    try {
      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'WITHDRAWAL_CONFIRMED',
        amountNgn: -withdrawal.amountNgn,
        referenceType: 'withdrawal',
        referenceId: withdrawalId
      })
      withdrawal.status = 'confirmed'
      withdrawal.processedAt = new Date().toISOString()
      return withdrawal
    } finally {
      await release()
    }
  }

  async failWithdrawal(withdrawalId: string, reason: string): Promise<WithdrawalResponse> {
    const withdrawal = this.withdrawals.find(w => w.id === withdrawalId)
    if (!withdrawal) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Withdrawal not found')
    if (withdrawal.status === 'failed') return withdrawal

    const userId = this.withdrawalUserIds.get(withdrawalId)!
    const wallet = await this.getOrCreateWallet(userId)
    const release = await ngnWalletStore.acquireLock(wallet.walletId)
    try {
      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'WITHDRAWAL_FAILED',
        amountNgn: withdrawal.amountNgn,
        referenceType: 'withdrawal',
        referenceId: withdrawalId
      })
      withdrawal.status = 'failed'
      withdrawal.processedAt = new Date().toISOString()
      withdrawal.failureReason = reason
      return withdrawal
    } finally {
      await release()
    }
  }

  async listWithdrawals(userId: string, options: { limit?: number; cursor?: string } = {}): Promise<WithdrawalHistoryResponse> {
    await this.getOrCreateWallet(userId)
    return this.getWithdrawalHistory(userId, options)
  }

  async getWithdrawalHistory(userId: string, options: { limit?: number; cursor?: string } = {}): Promise<WithdrawalHistoryResponse> {
    await this.getOrCreateWallet(userId)
    const userWithdrawals = this.withdrawals.filter(w => this.withdrawalUserIds.get(w.id) === userId)
    const limit = options.limit || 20
    return {
      entries: userWithdrawals.slice(0, limit),
      nextCursor: null
    }
  }

  async listNegativeBalances(options: {
    limit: number
    cursor?: string
    includeNonNegative?: boolean
  }): Promise<{
    items: { userId: string; balance: NgnBalanceResponse }[]
    nextCursor: string | null
  }> {
    const { items: wallets, nextCursor } = await ngnWalletStore.listWallets({
      limit: options.limit,
      cursor: options.cursor,
    })

    const results = []
    for (const wallet of wallets) {
      const balance = await this.getBalance(wallet.userId)
      if (options.includeNonNegative || balance.totalNgn < 0) {
        results.push({ userId: wallet.userId, balance })
      }
    }

    return { items: results, nextCursor }
  }

  /**
   * Approval only queues the payout. No money has moved yet, so the withdrawal
   * is not confirmed here. The payout worker sends the transfer and then
   * confirms or fails it (see claimForPayout / completePayout / failPayout).
   */
  async approveWithdrawal(withdrawalId: string): Promise<WithdrawalResponse> {
    const withdrawal = this.withdrawals.find(w => w.id === withdrawalId)
    if (!withdrawal) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Withdrawal not found')
    if (withdrawal.status === 'pending') {
      withdrawal.status = 'approved'
    }
    return withdrawal
  }

  getWithdrawal(withdrawalId: string): WithdrawalResponse | undefined {
    return this.withdrawals.find(w => w.id === withdrawalId)
  }

  getWithdrawalUserId(withdrawalId: string): string | undefined {
    return this.withdrawalUserIds.get(withdrawalId)
  }

  listWithdrawalsByStatus(status: WithdrawalResponse['status']): WithdrawalResponse[] {
    return this.withdrawals.filter(w => w.status === status)
  }

  getPayoutStartedAt(withdrawalId: string): number | undefined {
    return this.payoutStartedAt.get(withdrawalId)
  }

  /**
   * Moves an approved withdrawal to 'processing' so one caller owns the payout.
   * Returns null if it is not approved (already claimed, or not approved at all).
   * The check and the write have no await between them, so they are atomic in-process.
   */
  claimForPayout(withdrawalId: string): WithdrawalResponse | null {
    const withdrawal = this.withdrawals.find(w => w.id === withdrawalId)
    if (!withdrawal || withdrawal.status !== 'approved') return null
    withdrawal.status = 'processing'
    this.payoutStartedAt.set(withdrawalId, Date.now())
    return withdrawal
  }

  /**
   * Records a successful PSP transfer: writes WITHDRAWAL_CONFIRMED and sets
   * 'confirmed'. A withdrawal that is not 'processing' is returned unchanged,
   * so a duplicate PSP webhook cannot confirm it twice.
   */
  async completePayout(withdrawalId: string): Promise<WithdrawalResponse> {
    const withdrawal = this.withdrawals.find(w => w.id === withdrawalId)
    if (!withdrawal) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Withdrawal not found')
    if (withdrawal.status !== 'processing') return withdrawal

    // Claim the transition synchronously so a concurrent caller returns above
    withdrawal.status = 'confirmed'
    const userId = this.withdrawalUserIds.get(withdrawalId)!
    try {
      const wallet = await this.getOrCreateWallet(userId)
      const release = await ngnWalletStore.acquireLock(wallet.walletId)
      try {
        await ngnWalletStore.createLedgerEntry({
          walletId: wallet.walletId,
          type: 'WITHDRAWAL_CONFIRMED',
          amountNgn: -withdrawal.amountNgn,
          referenceType: 'withdrawal',
          referenceId: withdrawalId
        })
      } finally {
        await release()
      }
    } catch (error) {
      withdrawal.status = 'processing'
      throw error
    }
    this.payoutStartedAt.delete(withdrawalId)
    withdrawal.processedAt = new Date().toISOString()
    return withdrawal
  }

  /**
   * Records a failed PSP transfer: writes WITHDRAWAL_FAILED, which releases the
   * held funds back to available, and sets 'failed'. Ignored unless 'processing'.
   */
  async failPayout(withdrawalId: string, reason: string): Promise<WithdrawalResponse> {
    const withdrawal = this.withdrawals.find(w => w.id === withdrawalId)
    if (!withdrawal) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Withdrawal not found')
    if (withdrawal.status !== 'processing') return withdrawal

    withdrawal.status = 'failed'
    withdrawal.failureReason = reason
    const userId = this.withdrawalUserIds.get(withdrawalId)!
    try {
      const wallet = await this.getOrCreateWallet(userId)
      const release = await ngnWalletStore.acquireLock(wallet.walletId)
      try {
        await ngnWalletStore.createLedgerEntry({
          walletId: wallet.walletId,
          type: 'WITHDRAWAL_FAILED',
          amountNgn: withdrawal.amountNgn,
          referenceType: 'withdrawal',
          referenceId: withdrawalId
        })
      } finally {
        await release()
      }
    } catch (error) {
      withdrawal.status = 'processing'
      withdrawal.failureReason = null
      throw error
    }
    this.payoutStartedAt.delete(withdrawalId)
    withdrawal.processedAt = new Date().toISOString()
    return withdrawal
  }

  async rejectWithdrawal(withdrawalId: string, reason: string): Promise<WithdrawalResponse> {
    const withdrawal = this.withdrawals.find(w => w.id === withdrawalId)
    if (!withdrawal) throw new AppError(ErrorCode.NOT_FOUND, 404, 'Withdrawal not found')
    if (withdrawal.status === 'rejected') return withdrawal

    const userId = this.withdrawalUserIds.get(withdrawalId)!
    const wallet = await this.getOrCreateWallet(userId)
    const release = await ngnWalletStore.acquireLock(wallet.walletId)
    try {
      await ngnWalletStore.createLedgerEntry({
        walletId: wallet.walletId,
        type: 'WITHDRAWAL_FAILED',
        amountNgn: withdrawal.amountNgn,
        referenceType: 'withdrawal',
        referenceId: withdrawalId
      })
      withdrawal.status = 'rejected'
      withdrawal.processedAt = new Date().toISOString()
      withdrawal.failureReason = reason
      return withdrawal
    } finally {
      await release()
    }
  }
}
