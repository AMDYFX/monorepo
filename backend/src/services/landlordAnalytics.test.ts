import { describe, it, expect } from 'vitest'
import {
  computeOccupancyTrend,
  computeRevenueBreakdown,
  computePaymentTrends,
  computeVacancyMetrics,
  enumerateMonths,
} from './landlordAnalytics.js'

const start = new Date('2026-01-01T00:00:00.000Z')
const end = new Date('2026-03-01T00:00:00.000Z')

describe('landlord analytics metrics (#1958)', () => {
  describe('enumerateMonths', () => {
    it('includes both endpoints and partial months', () => {
      const from = new Date('2026-01-15T00:00:00.000Z')
      const to = new Date('2026-03-02T00:00:00.000Z')
      expect(enumerateMonths(from, to)).toEqual(['2026-01', '2026-02', '2026-03'])
    })
  })

  describe('computeOccupancyTrend', () => {
    it('returns zero-rate months when there are no properties', () => {
      const trend = computeOccupancyTrend([], start, end)
      expect(trend).toHaveLength(3)
      expect(trend.every((p) => p.rate === 0)).toBe(true)
    })

    it('prorates occupancy across partial-month leases', () => {
      const trend = computeOccupancyTrend(
        [
          {
            propertyId: 'p1',
            occupiedFrom: new Date('2026-02-15T00:00:00.000Z'),
            currentlyOccupied: true,
          },
          { propertyId: 'p2', currentlyOccupied: false },
        ],
        start,
        end,
      )
      expect(trend[0].rate).toBe(0) // neither occupied in January
      expect(trend[1].rate).toBe(50) // p1 occupied, p2 not
      expect(trend[2].rate).toBe(50)
    })

    it('treats a currently-occupied property as occupied from time immemorial', () => {
      const trend = computeOccupancyTrend(
        [{ propertyId: 'p1', currentlyOccupied: true }],
        start,
        end,
      )
      expect(trend.every((p) => p.rate === 100)).toBe(true)
    })
  })

  describe('computeRevenueBreakdown', () => {
    it('splits expected (by due month) from collected (by paid month)', () => {
      const breakdown = computeRevenueBreakdown(
        [
          {
            amountNgn: 100_000,
            dueDate: new Date('2026-01-05T00:00:00.000Z'),
            paidAt: new Date('2026-02-02T00:00:00.000Z'),
          },
          {
            amountNgn: 100_000,
            dueDate: new Date('2026-02-05T00:00:00.000Z'),
          },
        ],
        start,
        end,
      )
      expect(breakdown[0]).toMatchObject({ month: '2026-01', expected: 100_000, collected: 0 })
      expect(breakdown[1]).toMatchObject({ month: '2026-02', expected: 100_000, collected: 100_000 })
      expect(breakdown[2]).toMatchObject({ month: '2026-03', expected: 0, collected: 0 })
    })

    it('returns zero rows for an empty payment set', () => {
      const breakdown = computeRevenueBreakdown([], start, end)
      expect(breakdown).toHaveLength(3)
      expect(breakdown.every((p) => p.expected === 0 && p.collected === 0)).toBe(true)
    })
  })

  describe('computePaymentTrends', () => {
    it('classifies on-time, late and missed payments', () => {
      const trends = computePaymentTrends(
        [
          {
            amountNgn: 1,
            dueDate: new Date('2026-01-10T00:00:00.000Z'),
            paidAt: new Date('2026-01-09T00:00:00.000Z'),
          },
          {
            amountNgn: 1,
            dueDate: new Date('2026-01-10T00:00:00.000Z'),
            paidAt: new Date('2026-01-12T00:00:00.000Z'),
          },
          {
            amountNgn: 1,
            dueDate: new Date('2026-01-10T00:00:00.000Z'),
          },
        ],
        start,
        end,
      )
      expect(trends).toHaveLength(1)
      expect(trends[0]).toMatchObject({ date: '2026-01-10', onTime: 1, late: 1, missed: 1 })
    })

    it('ignores payments due outside the window', () => {
      const trends = computePaymentTrends(
        [
          {
            amountNgn: 1,
            dueDate: new Date('2025-12-01T00:00:00.000Z'),
            paidAt: new Date('2025-12-01T00:00:00.000Z'),
          },
        ],
        start,
        end,
      )
      expect(trends).toHaveLength(0)
    })
  })

  describe('computeVacancyMetrics', () => {
    it('returns zero average when nothing has been filled, but counts vacancies', () => {
      const metrics = computeVacancyMetrics(
        [
          { propertyId: 'p1', currentlyOccupied: false },
          { propertyId: 'p2', currentlyOccupied: true },
        ],
        [],
      )
      expect(metrics).toEqual({ averageTimeToFill: 0, currentVacancyCount: 1 })
    })

    it('averages days-to-fill across filled vacancies', () => {
      const metrics = computeVacancyMetrics(
        [{ propertyId: 'p1', currentlyOccupied: true }],
        [
          {
            availableFrom: new Date('2026-01-01T00:00:00.000Z'),
            filledAt: new Date('2026-01-11T00:00:00.000Z'),
          },
          {
            availableFrom: new Date('2026-02-01T00:00:00.000Z'),
            filledAt: new Date('2026-02-21T00:00:00.000Z'),
          },
        ],
      )
      expect(metrics.averageTimeToFill).toBe(15)
      expect(metrics.currentVacancyCount).toBe(0)
    })
  })
})
