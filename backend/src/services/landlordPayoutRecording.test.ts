import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemoryLandlordPayoutScheduleStore,
} from '../models/landlordPayoutScheduleStore.js'
import {
  payoutIdFor,
  recordLandlordPayoutForRentPayment,
  scheduleForPreference,
  type PayoutRecordingDeps,
} from './landlordPayoutRecording.js'

// Tuesday 20 Oct 2026, so the UTC week starts Monday 19 Oct.
const PAID_AT = new Date('2026-10-20T10:00:00.000Z')

describe('scheduleForPreference', () => {
  it('pays out at confirmation for activation landlords', () => {
    expect(scheduleForPreference('activation', PAID_AT)).toEqual({
      scheduledDate: PAID_AT,
      periodStart: PAID_AT,
      periodEnd: PAID_AT,
    })
  })

  it('schedules weekly landlords for the end of the UTC week that holds the payment', () => {
    const result = scheduleForPreference('weekly', PAID_AT)
    expect(result.periodStart.toISOString()).toBe('2026-10-19T00:00:00.000Z')
    expect(result.periodEnd.toISOString()).toBe('2026-10-26T00:00:00.000Z')
    expect(result.scheduledDate.toISOString()).toBe('2026-10-26T00:00:00.000Z')
  })

  it('treats a Sunday as the last day of its Monday-start week', () => {
    const sunday = new Date('2026-10-25T23:59:00.000Z')
    const result = scheduleForPreference('weekly', sunday)
    expect(result.periodStart.toISOString()).toBe('2026-10-19T00:00:00.000Z')
    expect(result.scheduledDate.toISOString()).toBe('2026-10-26T00:00:00.000Z')
  })

  it('schedules monthly landlords for the first day of the next UTC month', () => {
    const result = scheduleForPreference('monthly', PAID_AT)
    expect(result.periodStart.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(result.periodEnd.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(result.scheduledDate.toISOString()).toBe('2026-11-01T00:00:00.000Z')
  })
})

describe('payoutIdFor', () => {
  it('is stable for the same deal and payment, and differs for another payment', () => {
    const first = payoutIdFor('deal-1', 'paystack:ref-1')
    expect(payoutIdFor('deal-1', 'paystack:ref-1')).toBe(first)
    expect(payoutIdFor('deal-1', 'paystack:ref-2')).not.toBe(first)
    expect(payoutIdFor('deal-2', 'paystack:ref-1')).not.toBe(first)
    expect(first).toMatch(/^PAY-[0-9a-f]{32}$/)
  })
})

describe('recordLandlordPayoutForRentPayment', () => {
  let store: InMemoryLandlordPayoutScheduleStore
  let deps: PayoutRecordingDeps
  const payment = {
    dealId: 'deal-1',
    paymentRef: 'paystack:ref-1',
    amountNgn: 1_000_000,
    paidAt: PAID_AT,
  }

  beforeEach(async () => {
    store = new InMemoryLandlordPayoutScheduleStore()
    await store.setPreference('landlord-1', 'monthly')
    deps = {
      store,
      findDeal: async () => ({ landlordId: 'landlord-1', listingId: 'listing-1' }),
      findPropertyName: async () => '12 Admiralty Way, Lekki',
      isLandlordKycApproved: async () => true,
    }
  })

  it('creates a scheduled payout with the platform fee deducted, per the monthly preference', async () => {
    const result = await recordLandlordPayoutForRentPayment(payment, deps)

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    const { payout } = result
    expect(payout).toMatchObject({
      landlordId: 'landlord-1',
      propertyId: 'listing-1',
      propertyName: '12 Admiralty Way, Lekki',
      grossAmount: 1_000_000,
      netAmount: 800_000,
      currency: 'NGN',
      status: 'scheduled',
      channel: 'bank_transfer',
      delayReasons: [],
      scheduledDate: '2026-11-01T00:00:00.000Z',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
    })
    expect(payout.deductions).toEqual([
      { type: 'platform_fee', label: 'Platform Fee', amount: 200_000 },
    ])
    expect(await store.listForLandlord('landlord-1')).toHaveLength(1)
  })

  it('does not write a second row when the same payment is replayed', async () => {
    const first = await recordLandlordPayoutForRentPayment(payment, deps)
    const replay = await recordLandlordPayoutForRentPayment(payment, deps)

    expect(first.outcome).toBe('created')
    expect(replay).toEqual({ outcome: 'duplicate', payoutId: payoutIdFor('deal-1', 'paystack:ref-1') })
    expect(await store.listForLandlord('landlord-1')).toHaveLength(1)
  })

  it('delays the payout with kyc_incomplete when the landlord KYC is not approved', async () => {
    deps.isLandlordKycApproved = async () => false

    const result = await recordLandlordPayoutForRentPayment(payment, deps)

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(result.payout.status).toBe('delayed')
    expect(result.payout.delayReasons).toEqual(['kyc_incomplete'])
  })

  it('follows the weekly preference when the landlord has chosen it', async () => {
    await store.setPreference('landlord-1', 'weekly')

    const result = await recordLandlordPayoutForRentPayment(payment, deps)

    expect(result.outcome).toBe('created')
    if (result.outcome !== 'created') return
    expect(result.payout.scheduledDate).toBe('2026-10-26T00:00:00.000Z')
    expect(result.payout.periodStart).toBe('2026-10-19T00:00:00.000Z')
  })

  it('skips the payment when the deal does not exist', async () => {
    deps.findDeal = async () => null

    expect(await recordLandlordPayoutForRentPayment(payment, deps)).toEqual({
      outcome: 'skipped',
      reason: 'deal_not_found',
    })
    expect(await store.listForLandlord('landlord-1')).toHaveLength(0)
  })

  it('skips the payment when the deal has no listing to attribute it to', async () => {
    deps.findDeal = async () => ({ landlordId: 'landlord-1', listingId: null })

    expect(await recordLandlordPayoutForRentPayment(payment, deps)).toEqual({
      outcome: 'skipped',
      reason: 'listing_missing',
    })
    expect(await store.listForLandlord('landlord-1')).toHaveLength(0)
  })
})

describe('InMemoryLandlordPayoutScheduleStore.sumGrossSince', () => {
  it('sums non-failed payouts created since the given time for one landlord', async () => {
    const store = new InMemoryLandlordPayoutScheduleStore()
    const base = {
      propertyId: 'listing-1',
      propertyName: 'Flat',
      scheduledDate: '2026-11-01T00:00:00.000Z',
      completedDate: null,
      deductions: [],
      netAmount: 0,
      currency: 'NGN',
      channel: 'bank_transfer' as const,
      delayReasons: [],
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
    }
    const recent = new Date().toISOString()
    const old = '2020-01-01T00:00:00.000Z'
    store.add({ ...base, id: 'a', landlordId: 'landlord-1', grossAmount: 500, status: 'scheduled', createdAt: recent, updatedAt: recent })
    store.add({ ...base, id: 'b', landlordId: 'landlord-1', grossAmount: 300, status: 'failed', createdAt: recent, updatedAt: recent })
    store.add({ ...base, id: 'c', landlordId: 'landlord-1', grossAmount: 900, status: 'scheduled', createdAt: old, updatedAt: old })
    store.add({ ...base, id: 'd', landlordId: 'landlord-2', grossAmount: 700, status: 'scheduled', createdAt: recent, updatedAt: recent })

    const total = await store.sumGrossSince('landlord-1', new Date('2026-01-01T00:00:00.000Z'))
    expect(total).toBe(500)
  })
})
