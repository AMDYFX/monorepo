import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearLandlordDashboardStatsCache,
  DASHBOARD_STATS_TTL_MS,
  getLandlordDashboardStats,
  startOfUtcMonth,
  type DashboardStatsDeps,
} from './landlordDashboardStats.js'
import type { LandlordProperty, PaginatedProperties } from '../models/landlordProperty.js'

const NOW = Date.UTC(2026, 9, 20, 10, 0, 0) // 20 Oct 2026, 10:00 UTC

function property(status: string, views: number): LandlordProperty {
  return { status, views } as unknown as LandlordProperty
}

function page(
  properties: LandlordProperty[],
  pageNumber: number,
  totalPages: number,
  total: number,
): PaginatedProperties {
  return { properties, total, page: pageNumber, pageSize: 100, totalPages }
}

describe('getLandlordDashboardStats', () => {
  let nowMs: number
  let listCalls: number
  let revenueCalls: Date[]

  function makeDeps(pages: PaginatedProperties[], revenue = 0): DashboardStatsDeps {
    return {
      listProperties: async (_landlordId, pageNumber) => {
        listCalls += 1
        return pages[pageNumber - 1] ?? page([], pageNumber, pages.length, 0)
      },
      sumRevenueSince: async (_landlordId, since) => {
        revenueCalls.push(since)
        return revenue
      },
      now: () => nowMs,
    }
  }

  beforeEach(() => {
    clearLandlordDashboardStatsCache()
    nowMs = NOW
    listCalls = 0
    revenueCalls = []
  })

  it('counts properties, active listings and views, and sums this month revenue', async () => {
    const deps = makeDeps(
      [page([property('approved', 120), property('pending_review', 5), property('active', 10)], 1, 1, 3)],
      2_500_000,
    )

    const stats = await getLandlordDashboardStats('landlord-a', deps)

    expect(stats).toEqual({
      totalProperties: 3,
      activeListings: 2,
      totalViews: 135,
      monthlyRevenueNgn: 2_500_000,
    })
    expect(revenueCalls).toHaveLength(1)
    expect(revenueCalls[0].toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  it('reads every page of properties before totalling', async () => {
    const deps = makeDeps([
      page([property('approved', 1), property('approved', 2)], 1, 2, 3),
      page([property('deactivated', 4)], 2, 2, 3),
    ])

    const stats = await getLandlordDashboardStats('landlord-b', deps)

    expect(listCalls).toBe(2)
    expect(stats.totalProperties).toBe(3)
    expect(stats.activeListings).toBe(2)
    expect(stats.totalViews).toBe(7)
  })

  it('returns zeros for a landlord with no properties and no payouts', async () => {
    const stats = await getLandlordDashboardStats('landlord-empty', makeDeps([page([], 1, 0, 0)]))

    expect(stats).toEqual({ totalProperties: 0, activeListings: 0, totalViews: 0, monthlyRevenueNgn: 0 })
  })

  it('serves a cached result within the TTL and recomputes after it', async () => {
    const deps = makeDeps([page([property('approved', 10)], 1, 1, 1)], 100)

    await getLandlordDashboardStats('landlord-c', deps)
    nowMs += DASHBOARD_STATS_TTL_MS - 1
    await getLandlordDashboardStats('landlord-c', deps)
    expect(listCalls).toBe(1)

    nowMs += 2
    await getLandlordDashboardStats('landlord-c', deps)
    expect(listCalls).toBe(2)
  })
})

describe('startOfUtcMonth', () => {
  it('returns midnight UTC on the first day of the month', () => {
    expect(startOfUtcMonth(new Date('2026-10-20T23:59:59.000Z')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    )
  })
})
