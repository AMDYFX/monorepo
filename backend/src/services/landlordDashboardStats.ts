/**
 * Landlord dashboard headline numbers (issue #1957).
 *
 * - totalProperties: every property the landlord has in landlord_properties,
 *   whatever its status.
 * - activeListings: properties that are live (approved, or the legacy `active`).
 * - totalViews: the sum of `views` on the landlord's properties. Views are
 *   tracked through incrementViews, so this is a real count.
 * - monthlyRevenueNgn: gross of the payouts recorded from confirmed rent
 *   payments during the current UTC calendar month (see landlordPayoutRecording).
 *   Failed payouts are excluded.
 *
 * Results are cached per landlord for 60 seconds to keep the dashboard cheap.
 */

import { landlordPropertyStore } from '../models/landlordPropertyStore.js'
import { PropertyStatus, type PaginatedProperties } from '../models/landlordProperty.js'
import { landlordPayoutScheduleStore } from '../models/landlordPayoutScheduleStore.js'

export interface LandlordDashboardStats {
  totalProperties: number
  activeListings: number
  totalViews: number
  monthlyRevenueNgn: number
}

export const DASHBOARD_STATS_TTL_MS = 60_000

const PAGE_SIZE = 100
const ACTIVE_STATUSES: ReadonlySet<PropertyStatus> = new Set([
  PropertyStatus.APPROVED,
  PropertyStatus.ACTIVE,
])

export interface DashboardStatsDeps {
  listProperties: (landlordId: string, page: number, pageSize: number) => Promise<PaginatedProperties>
  sumRevenueSince: (landlordId: string, since: Date) => Promise<number>
  now: () => number
}

function defaultDeps(): DashboardStatsDeps {
  return {
    listProperties: (landlordId, page, pageSize) =>
      landlordPropertyStore.list({ landlordId, page, pageSize }),
    sumRevenueSince: (landlordId, since) =>
      landlordPayoutScheduleStore.sumGrossSince(landlordId, since),
    now: () => Date.now(),
  }
}

/** Start of the current UTC calendar month. */
export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

const cache = new Map<string, { expiresAt: number; value: LandlordDashboardStats }>()

/** Test helper: forget cached stats so the next read recomputes them. */
export function clearLandlordDashboardStatsCache(): void {
  cache.clear()
}

export async function getLandlordDashboardStats(
  landlordId: string,
  deps: DashboardStatsDeps = defaultDeps(),
): Promise<LandlordDashboardStats> {
  const nowMs = deps.now()
  const cached = cache.get(landlordId)
  if (cached && cached.expiresAt > nowMs) {
    return cached.value
  }

  let totalProperties = 0
  let activeListings = 0
  let totalViews = 0
  for (let page = 1; ; page += 1) {
    const result = await deps.listProperties(landlordId, page, PAGE_SIZE)
    if (page === 1) totalProperties = result.total
    for (const property of result.properties) {
      totalViews += property.views
      if (ACTIVE_STATUSES.has(property.status)) activeListings += 1
    }
    if (result.properties.length === 0 || page >= result.totalPages) break
  }

  const monthlyRevenueNgn = await deps.sumRevenueSince(landlordId, startOfUtcMonth(new Date(nowMs)))

  const value = { totalProperties, activeListings, totalViews, monthlyRevenueNgn }
  cache.set(landlordId, { expiresAt: nowMs + DASHBOARD_STATS_TTL_MS, value })
  return value
}
