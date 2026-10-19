/**
 * Landlord analytics data gathering (#1958).
 *
 * Pulls the landlord's properties, deals and repayment schedules, normalises
 * them into the pure-metric inputs and delegates the maths to
 * `services/landlordAnalytics.ts`.
 */

import { landlordPropertyStore } from '../models/landlordPropertyStore.js'
import { dealStore } from '../models/dealStore.js'
import { listingStore } from '../models/listingStore.js'
import { DealStatus } from '../models/deal.js'
import { getSchedule } from './repaymentScheduleService.js'
import {
  computeOccupancyTrend,
  computeRevenueBreakdown,
  computePaymentTrends,
  computeVacancyMetrics,
  type OccupancyInput,
  type PaymentRecord,
  type OccupancyPoint,
  type RevenuePoint,
  type PaymentTrendPoint,
  type VacancyMetrics,
} from './landlordAnalytics.js'

export interface LandlordAnalyticsResult {
  occupancyTrend: OccupancyPoint[]
  revenueBreakdown: RevenuePoint[]
  paymentTrends: PaymentTrendPoint[]
  vacancyMetrics: VacancyMetrics
}

const OCCUPIED_STATUSES = new Set<DealStatus>([
  DealStatus.ACTIVE,
  DealStatus.AT_RISK,
  DealStatus.COMPLETED,
  DealStatus.DEFAULTED,
])

/**
 * Compute analytics for a landlord between `start` and `end`, optionally scoped
 * to a single property. Properties not owned by the landlord are never included.
 */
export async function computeLandlordAnalytics(params: {
  landlordId: string
  start: Date
  end: Date
  propertyId?: string
}): Promise<LandlordAnalyticsResult> {
  const { landlordId, start, end, propertyId } = params

  const { properties } = await landlordPropertyStore.list({
    landlordId,
    page: 1,
    pageSize: 1000,
  })
  const scopedProperties = propertyId
    ? properties.filter((p) => p.id === propertyId)
    : properties

  // Map each property to its current rental state via the deal that references
  // its synced listing.
  const occupancyInputs: OccupancyInput[] = []
  const allPayments: PaymentRecord[] = []
  const filledVacancies: Array<{ availableFrom: Date; filledAt: Date }> = []

  for (const property of scopedProperties) {
    const listing = property.listingId ? await listingStore.getById(property.listingId) : null
    const deal = listing?.dealId ? await dealStore.findById(listing.dealId) : null

    const currentlyOccupied = deal ? OCCUPIED_STATUSES.has(deal.status) : false
    occupancyInputs.push({
      propertyId: property.id,
      occupiedFrom: deal && OCCUPIED_STATUSES.has(deal.status) ? deal.createdAt : undefined,
      occupiedUntil: undefined,
      currentlyOccupied,
    })

    if (deal) {
      if (!currentlyOccupied) {
        filledVacancies.push({ availableFrom: property.createdAt, filledAt: deal.createdAt })
      }
      const schedule = await loadSchedule(deal.dealId, deal)
      allPayments.push(...schedule)
    } else {
      // Never rented since listing: an open vacancy with no fill time yet.
      filledVacancies.push({ availableFrom: property.createdAt, filledAt: new Date() })
    }
  }

  return {
    occupancyTrend: computeOccupancyTrend(occupancyInputs, start, end),
    revenueBreakdown: computeRevenueBreakdown(allPayments, start, end),
    paymentTrends: computePaymentTrends(allPayments, start, end),
    vacancyMetrics: computeVacancyMetrics(occupancyInputs, filledVacancies),
  }
}

/** Load a deal's repayment schedule, falling back to its generated schedule. */
async function loadSchedule(
  dealId: string,
  deal: { schedule: Array<{ dueDate: string; amountNgn: number; status: string }> },
): Promise<PaymentRecord[]> {
  try {
    const stored = await getSchedule(dealId)
    if (stored && stored.schedule.length > 0) {
      return stored.schedule.map((item) => ({
        amountNgn: item.totalAmountNgn,
        dueDate: item.dueDate,
        paidAt: item.paidAt,
      }))
    }
  } catch {
    // No database configured (tests / preview): fall through to the in-memory
    // schedule that lives on the deal.
  }

  return deal.schedule.map((item) => ({
    amountNgn: item.amountNgn,
    dueDate: new Date(item.dueDate),
    paidAt: item.status === 'paid' ? new Date(item.dueDate) : undefined,
  }))
}
