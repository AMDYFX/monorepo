/**
 * Landlord payout recording (issue #1955).
 *
 * Writes a `landlord_payouts` row for each confirmed rent payment so the payout
 * schedule API and the landlord dashboard have a ledger to read from.
 *
 * - Amounts come from computePayoutScheduleFromInput, the existing instalment
 *   split, so the platform fee is not re-derived here.
 * - The row's schedule follows the landlord's schedule_preference:
 *     activation  paid out at confirmation
 *     weekly      paid at the end of the UTC week (Monday 00:00) that holds the payment
 *     monthly     paid at the end of the UTC month that holds the payment
 * - The payout id is derived from the deal and the payment reference, so a
 *   replayed settlement hits the same row and writes nothing new.
 * - A landlord without an approved KYC record gets status `delayed` with the
 *   `kyc_incomplete` reason. Other blockers, such as a payment dispute hold, are
 *   not checked here because there is no lookup from a deal to its disputes yet.
 * - Each confirmed payment becomes its own row. Rows are grouped into periods
 *   when they are read, so this does not merge them into one row per period.
 */

import { createHash } from 'node:crypto'
import { dealStore } from '../models/dealStore.js'
import { listingStore } from '../models/listingStore.js'
import {
  landlordPayoutScheduleStore,
  type LandlordPayoutScheduleStore,
} from '../models/landlordPayoutScheduleStore.js'
import { kycRepository } from '../repositories/KycRepository.js'
import type {
  DelayReason,
  LandlordPayout,
  PayoutSchedulePreference,
} from '../schemas/landlordPayoutSchedule.js'
import { computePayoutScheduleFromInput, toDeductions } from './landlordPayoutService.js'
import { logger } from '../utils/logger.js'

export interface ConfirmedRentPayment {
  dealId: string
  /** Unique per payment, e.g. "{externalRefSource}:{externalRef}". */
  paymentRef: string
  amountNgn: number
  paidAt: Date
}

export interface PayoutRecordingDeps {
  store: LandlordPayoutScheduleStore
  findDeal: (dealId: string) => Promise<{ landlordId: string; listingId: string | null } | null>
  findPropertyName: (listingId: string) => Promise<string | null>
  isLandlordKycApproved: (landlordId: string) => Promise<boolean>
}

export type RecordPayoutOutcome =
  | { outcome: 'created'; payout: LandlordPayout }
  | { outcome: 'duplicate'; payoutId: string }
  | { outcome: 'skipped'; reason: 'deal_not_found' | 'listing_missing' }

function defaultDeps(): PayoutRecordingDeps {
  return {
    store: landlordPayoutScheduleStore,
    findDeal: async (dealId) => {
      const deal = await dealStore.findById(dealId)
      if (!deal) return null
      return { landlordId: deal.landlordId, listingId: deal.listingId ?? null }
    },
    findPropertyName: async (listingId) => {
      const listing = await listingStore.getById(listingId)
      return listing?.address ?? null
    },
    isLandlordKycApproved: async (landlordId) => {
      const record = await kycRepository.findByUserId(landlordId)
      return record?.status === 'approved'
    },
  }
}

/** Deterministic id so a replayed payment maps to the same payout row. */
export function payoutIdFor(dealId: string, paymentRef: string): string {
  const digest = createHash('sha256').update(`${dealId}|${paymentRef}`).digest('hex')
  return `PAY-${digest.slice(0, 32)}`
}

function startOfUtcWeek(date: Date): Date {
  // Monday is the first day of the week. getUTCDay() gives 0 for Sunday.
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday))
}

/**
 * Schedule for one payout under a preference. The period is the window the
 * payment falls in, and the payout is scheduled for the end of that window.
 */
export function scheduleForPreference(
  preference: PayoutSchedulePreference,
  paidAt: Date,
): { scheduledDate: Date; periodStart: Date; periodEnd: Date } {
  if (preference === 'activation') {
    return { scheduledDate: paidAt, periodStart: paidAt, periodEnd: paidAt }
  }

  if (preference === 'weekly') {
    const periodStart = startOfUtcWeek(paidAt)
    const periodEnd = new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1000)
    return { scheduledDate: periodEnd, periodStart, periodEnd }
  }

  const periodStart = new Date(Date.UTC(paidAt.getUTCFullYear(), paidAt.getUTCMonth(), 1))
  const periodEnd = new Date(Date.UTC(paidAt.getUTCFullYear(), paidAt.getUTCMonth() + 1, 1))
  return { scheduledDate: periodEnd, periodStart, periodEnd }
}

export async function recordLandlordPayoutForRentPayment(
  payment: ConfirmedRentPayment,
  deps: PayoutRecordingDeps = defaultDeps(),
): Promise<RecordPayoutOutcome> {
  const deal = await deps.findDeal(payment.dealId)
  if (!deal) {
    return { outcome: 'skipped', reason: 'deal_not_found' }
  }
  if (!deal.listingId) {
    // property_id is required on the payout, so a deal with no listing cannot be recorded
    return { outcome: 'skipped', reason: 'listing_missing' }
  }

  const id = payoutIdFor(payment.dealId, payment.paymentRef)
  const preference = await deps.store.getPreference(deal.landlordId)
  const propertyName = (await deps.findPropertyName(deal.listingId)) ?? deal.listingId

  const schedule = computePayoutScheduleFromInput({
    dealId: payment.dealId,
    landlordId: deal.landlordId,
    depositNgn: 0,
    instalmentAmountsNgn: [payment.amountNgn],
  })
  const line = schedule.lines.find((l) => l.kind === 'instalment')
  if (!line) {
    throw new Error('instalment payout line missing from computed schedule')
  }

  const kycApproved = await deps.isLandlordKycApproved(deal.landlordId)
  const delayReasons: DelayReason[] = kycApproved ? [] : ['kyc_incomplete']

  const { scheduledDate, periodStart, periodEnd } = scheduleForPreference(preference, payment.paidAt)
  const now = new Date().toISOString()
  const payout: LandlordPayout = {
    id,
    landlordId: deal.landlordId,
    propertyId: deal.listingId,
    propertyName,
    scheduledDate: scheduledDate.toISOString(),
    completedDate: null,
    grossAmount: line.grossAmount,
    deductions: toDeductions(line),
    netAmount: line.netAmount,
    currency: 'NGN',
    status: delayReasons.length > 0 ? 'delayed' : 'scheduled',
    channel: 'bank_transfer',
    delayReasons,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    createdAt: now,
    updatedAt: now,
  }

  const inserted = await deps.store.insertIfAbsent(payout)
  if (!inserted) {
    logger.info('Landlord payout already recorded for payment', { dealId: payment.dealId, payoutId: id })
    return { outcome: 'duplicate', payoutId: id }
  }
  return { outcome: 'created', payout }
}
