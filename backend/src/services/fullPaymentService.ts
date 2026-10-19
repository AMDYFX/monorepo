/**
 * Full-payment preview & confirmation (#1961).
 *
 * The tenant selects a deal on the payments page and asks to pay the whole
 * outstanding balance. `preview` computes the payout split without mutating
 * anything; `confirm` settles the incentive (writing settlement ledger entries)
 * and returns a receipt.
 *
 * The `paymentId` passed by the client is a DEAL id (see
 * `frontend/app/dashboard/tenant/payments/page.tsx` → `selectedDeal`).
 */

import { randomUUID } from 'node:crypto'
import { dealStore } from '../models/dealStore.js'
import { listingStore } from '../models/listingStore.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { computeFullPaymentSplit } from './fullPaymentSplit.js'
import { settleFullPaymentIncentive } from './fullPaymentIncentiveSettlement.js'

/** How long a preview remains valid, in milliseconds (15 minutes). */
export const FULL_PAYMENT_PREVIEW_TTL_MS = 15 * 60 * 1000

export interface PayoutBreakdown {
  totalAmount: number
  platformShare: number
  reporterShare: number | null
  landlordAmount: number
  currency: string
}

export interface FullPaymentPreviewResult {
  paymentId: string
  breakdown: PayoutBreakdown
  expiresAt: string
}

export interface FullPaymentReceiptResult {
  paymentId: string
  reference: string
  breakdown: PayoutBreakdown
  paidAt: string
  status: 'confirmed'
}

interface DealForPayment {
  dealId: string
  tenantId: string
  landlordId: string
  listingId?: string
  financedAmountNgn: number
}

async function requireTenantDeal(dealId: string, tenantId: string): Promise<DealForPayment> {
  const deal = await dealStore.findById(dealId)
  if (!deal || deal.tenantId !== tenantId) {
    throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
  }
  return deal
}

/**
 * Build the payout breakdown for paying `grossAmountNgn` in full. Exported so
 * both preview and confirm share exactly the same maths.
 */
export async function buildFullPaymentBreakdown(
  deal: DealForPayment,
  grossAmountNgn: number,
): Promise<PayoutBreakdown> {
  if (!Number.isFinite(grossAmountNgn) || grossAmountNgn < deal.financedAmountNgn) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      400,
      'Full payment must cover the financed amount',
    )
  }

  const listing = deal.listingId ? await listingStore.getById(deal.listingId) : null
  const reporterApplied = Boolean(listing?.whistleblowerId?.trim())
  const split = computeFullPaymentSplit({ grossAmountNgn, reporterApplied })

  return {
    totalAmount: split.grossAmountNgn,
    platformShare: split.platformAmountNgn,
    reporterShare: reporterApplied ? split.reporterAmountNgn : null,
    landlordAmount: split.landlordNetAmountNgn,
    currency: 'NGN',
  }
}

export async function previewFullPayment(params: {
  dealId: string
  tenantId: string
}): Promise<FullPaymentPreviewResult> {
  const deal = await requireTenantDeal(params.dealId, params.tenantId)
  const breakdown = await buildFullPaymentBreakdown(deal, deal.financedAmountNgn)

  return {
    paymentId: deal.dealId,
    breakdown,
    expiresAt: new Date(Date.now() + FULL_PAYMENT_PREVIEW_TTL_MS).toISOString(),
  }
}

export async function confirmFullPayment(params: {
  dealId: string
  tenantId: string
}): Promise<FullPaymentReceiptResult> {
  const deal = await requireTenantDeal(params.dealId, params.tenantId)
  const breakdown = await buildFullPaymentBreakdown(deal, deal.financedAmountNgn)

  await settleFullPaymentIncentive({
    dealId: deal.dealId,
    grossAmountNgn: deal.financedAmountNgn,
  })

  const paidAt = new Date().toISOString()
  return {
    paymentId: deal.dealId,
    reference: `FULL-${deal.dealId.slice(0, 8).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    breakdown,
    paidAt,
    status: 'confirmed',
  }
}
