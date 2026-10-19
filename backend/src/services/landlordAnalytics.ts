/**
 * Pure computation helpers for landlord analytics (#1958).
 *
 * Kept free of I/O so the metric maths (including the empty and partial-month
 * edge cases) can be unit-tested directly. The route layer feeds these
 * functions normalised inputs gathered from deals, listings and payments.
 */

export interface OccupancyInput {
  /** Property/listing identifier. */
  propertyId: string
  /** When the property became occupied (deal start), if ever. */
  occupiedFrom?: Date
  /** When the property was vacated, if it has been. */
  occupiedUntil?: Date
  /** Whether the property is currently occupied. */
  currentlyOccupied: boolean
}

export interface OccupancyPoint {
  date: string
  rate: number
}

export interface PaymentRecord {
  /** Instalment amount expected for the period. */
  amountNgn: number
  /** Due date of the instalment. */
  dueDate: Date
  /** When it was actually paid, if it was. */
  paidAt?: Date
}

export interface RevenuePoint {
  month: string
  expected: number
  collected: number
}

export interface PaymentTrendPoint {
  date: string
  onTime: number
  late: number
  missed: number
}

export interface VacancyMetrics {
  averageTimeToFill: number
  currentVacancyCount: number
}

/** Inclusive month iterator producing `YYYY-MM` keys between two dates. */
export function enumerateMonths(start: Date, end: Date): string[] {
  const months: string[] = []
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  while (cursor <= last) {
    months.push(monthKey(cursor))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return months
}

export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Occupancy rate per month: the share of properties occupied at any point
 * during the month. Returns `rate: 0` for months with no properties.
 */
export function computeOccupancyTrend(
  properties: OccupancyInput[],
  start: Date,
  end: Date,
): OccupancyPoint[] {
  const months = enumerateMonths(start, end)
  return months.map((month) => {
    if (properties.length === 0) return { date: month, rate: 0 }
    const monthStart = new Date(`${month}-01T00:00:00.000Z`)
    const monthEnd = new Date(monthStart)
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1)
    monthEnd.setUTCMilliseconds(-1)

    const occupied = properties.filter((p) =>
      overlaps(p, monthStart, monthEnd),
    ).length
    return { date: month, rate: Math.round((occupied / properties.length) * 100) }
  })
}

function overlaps(p: OccupancyInput, from: Date, to: Date): boolean {
  const pStart = p.occupiedFrom ?? (p.currentlyOccupied ? new Date(0) : null)
  if (pStart && pStart > to) return false
  const pEnd = p.occupiedUntil ?? (p.currentlyOccupied ? null : pStart)
  if (pEnd && pEnd < from) return false
  return pStart !== null || p.currentlyOccupied
}

/**
 * Expected vs collected rent per month across all payments. `collected` counts
 * a payment in the month it was PAID; `expected` counts it in the month it was
 * DUE. Payments with no `paidAt` contribute only to `expected`.
 */
export function computeRevenueBreakdown(
  payments: PaymentRecord[],
  start: Date,
  end: Date,
): RevenuePoint[] {
  const months = enumerateMonths(start, end)
  const expected = new Map<string, number>()
  const collected = new Map<string, number>()

  for (const payment of payments) {
    const dueMonth = monthKey(payment.dueDate)
    expected.set(dueMonth, (expected.get(dueMonth) ?? 0) + payment.amountNgn)

    if (payment.paidAt) {
      const paidMonth = monthKey(payment.paidAt)
      collected.set(paidMonth, (collected.get(paidMonth) ?? 0) + payment.amountNgn)
    }
  }

  return months.map((month) => ({
    month,
    expected: expected.get(month) ?? 0,
    collected: collected.get(month) ?? 0,
  }))
}

/**
 * On-time / late / missed counts per due date. A payment is on-time when paid
 * on or before its due date, late when paid after, and missed when unpaid and
 * past due.
 */
export function computePaymentTrends(
  payments: PaymentRecord[],
  start: Date,
  end: Date,
): PaymentTrendPoint[] {
  const buckets = new Map<string, PaymentTrendPoint>()

  for (const payment of payments) {
    if (payment.dueDate < start || payment.dueDate > end) continue
    const key = dayKey(payment.dueDate)
    const point = buckets.get(key) ?? { date: key, onTime: 0, late: 0, missed: 0 }

    if (!payment.paidAt) {
      point.missed += 1
    } else if (payment.paidAt.getTime() <= payment.dueDate.getTime()) {
      point.onTime += 1
    } else {
      point.late += 1
    }

    buckets.set(key, point)
  }

  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Vacancy metrics. `averageTimeToFill` is the mean days between a property
 * becoming available and its next deal start, across filled vacancies; it is 0
 * when no vacancy has been filled. `currentVacancyCount` counts properties with
 * no active tenant.
 */
export function computeVacancyMetrics(
  properties: OccupancyInput[],
  filledVacancies: Array<{ availableFrom: Date; filledAt: Date }>,
): VacancyMetrics {
  const currentVacancyCount = properties.filter((p) => !p.currentlyOccupied).length

  if (filledVacancies.length === 0) {
    return { averageTimeToFill: 0, currentVacancyCount }
  }

  const totalDays = filledVacancies.reduce((sum, v) => {
    const days = (v.filledAt.getTime() - v.availableFrom.getTime()) / (1000 * 60 * 60 * 24)
    return sum + Math.max(0, days)
  }, 0)

  return {
    averageTimeToFill: Math.round(totalDays / filledVacancies.length),
    currentVacancyCount,
  }
}
