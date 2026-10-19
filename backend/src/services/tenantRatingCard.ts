/**
 * Pure rules for the tenant rating card (#1905).
 *
 * Eligibility: a landlord may rate a tenant for a deal when the deal is
 * `completed`, or when it is `active` and has run for at least
 * MIN_TENURE_MONTHS_FOR_RATING months from its creation date. Other statuses
 * (draft, at_risk, defaulted) cannot be rated.
 */

import { createHash, randomBytes } from 'node:crypto'

export const MIN_TENURE_MONTHS_FOR_RATING = 3

export interface RatingScores {
  paymentTimeliness: number
  propertyCare: number
  communication: number
}

/** Overall score is the mean of the three dimensions, rounded to the nearest whole star. */
export function computeOverallScore(scores: RatingScores): number {
  const mean = (scores.paymentTimeliness + scores.propertyCare + scores.communication) / 3
  return Math.round(mean)
}

export type RatingEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'status_not_ratable' | 'tenure_too_short' }

export function checkRatingEligibility(
  deal: { status: string; createdAt: Date },
  now: Date,
): RatingEligibility {
  if (deal.status === 'completed') return { eligible: true }
  if (deal.status !== 'active') return { eligible: false, reason: 'status_not_ratable' }

  const threshold = new Date(deal.createdAt)
  threshold.setUTCMonth(threshold.getUTCMonth() + MIN_TENURE_MONTHS_FOR_RATING)
  return now >= threshold ? { eligible: true } : { eligible: false, reason: 'tenure_too_short' }
}

export interface RatingRecordForAggregate extends RatingScores {
  overall: number
  comment: string | null
  createdAt: Date
}

export interface RatingAggregate {
  count: number
  averages: {
    paymentTimeliness: number | null
    propertyCare: number | null
    communication: number | null
    overall: number | null
  }
  recentComments: string[]
}

const RECENT_COMMENT_LIMIT = 5

function average(values: number[]): number | null {
  if (values.length === 0) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  return Math.round((total / values.length) * 100) / 100
}

export function aggregateRatings(ratings: RatingRecordForAggregate[]): RatingAggregate {
  const newestFirst = [...ratings].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const recentComments = newestFirst
    .map((rating) => rating.comment?.trim() ?? '')
    .filter((comment) => comment.length > 0)
    .slice(0, RECENT_COMMENT_LIMIT)

  return {
    count: ratings.length,
    averages: {
      paymentTimeliness: average(ratings.map((r) => r.paymentTimeliness)),
      propertyCare: average(ratings.map((r) => r.propertyCare)),
      communication: average(ratings.map((r) => r.communication)),
      overall: average(ratings.map((r) => r.overall)),
    },
    recentComments,
  }
}

/**
 * First name and last initial only, for the public card. Falls back to a
 * generic label rather than exposing an email or a full name.
 */
export function maskDisplayName(fullName: string | null | undefined): string {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean)
  // A name that is really an email address must not be shown at all.
  if (parts.length === 0 || parts[0].includes('@')) return 'Tenant'
  if (parts.length === 1) return parts[0]
  const lastInitial = parts[parts.length - 1][0].toUpperCase()
  return `${parts[0]} ${lastInitial}.`
}

/** 128 bits of randomness, rendered as 32 lowercase hex characters. */
export function generateShareToken(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Only the hash is stored, so a leaked database does not reveal live share links.
 * Lookups compare hashes, so the raw token never reaches the database.
 */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function shareExpiryFrom(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000)
}
