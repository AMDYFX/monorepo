import { describe, expect, it } from 'vitest'
import {
  aggregateRatings,
  checkRatingEligibility,
  computeOverallScore,
  generateShareToken,
  hashShareToken,
  maskDisplayName,
  MIN_TENURE_MONTHS_FOR_RATING,
  shareExpiryFrom,
} from './tenantRatingCard.js'

describe('checkRatingEligibility', () => {
  const created = new Date('2026-01-15T00:00:00Z')

  it('allows completed deals regardless of tenure', () => {
    expect(checkRatingEligibility({ status: 'completed', createdAt: created }, created)).toEqual({ eligible: true })
  })

  it('allows active deals once they have run for the minimum tenure', () => {
    const now = new Date('2026-04-15T00:00:00Z')
    expect(MIN_TENURE_MONTHS_FOR_RATING).toBe(3)
    expect(checkRatingEligibility({ status: 'active', createdAt: created }, now)).toEqual({ eligible: true })
  })

  it('rejects active deals younger than the minimum tenure', () => {
    const now = new Date('2026-04-14T23:59:59Z')
    expect(checkRatingEligibility({ status: 'active', createdAt: created }, now)).toEqual({
      eligible: false,
      reason: 'tenure_too_short',
    })
  })

  it('rejects statuses that cannot be rated', () => {
    for (const status of ['draft', 'at_risk', 'defaulted']) {
      expect(checkRatingEligibility({ status, createdAt: created }, new Date('2030-01-01'))).toEqual({
        eligible: false,
        reason: 'status_not_ratable',
      })
    }
  })
})

describe('computeOverallScore', () => {
  it('rounds the mean of the three dimensions to a whole star', () => {
    expect(computeOverallScore({ paymentTimeliness: 5, propertyCare: 4, communication: 4 })).toBe(4)
    expect(computeOverallScore({ paymentTimeliness: 5, propertyCare: 5, communication: 4 })).toBe(5)
    expect(computeOverallScore({ paymentTimeliness: 1, propertyCare: 1, communication: 2 })).toBe(1)
  })
})

describe('aggregateRatings', () => {
  it('returns null averages and no comments when there are no ratings', () => {
    expect(aggregateRatings([])).toEqual({
      count: 0,
      averages: { paymentTimeliness: null, propertyCare: null, communication: null, overall: null },
      recentComments: [],
    })
  })

  it('averages each dimension, newest comments first, skipping blanks', () => {
    const result = aggregateRatings([
      { paymentTimeliness: 5, propertyCare: 3, communication: 4, overall: 4, comment: 'old', createdAt: new Date('2026-01-01') },
      { paymentTimeliness: 4, propertyCare: 4, communication: 4, overall: 4, comment: '  ', createdAt: new Date('2026-03-01') },
      { paymentTimeliness: 3, propertyCare: 4, communication: 5, overall: 4, comment: 'new', createdAt: new Date('2026-02-01') },
    ])
    expect(result.count).toBe(3)
    expect(result.averages.paymentTimeliness).toBe(4)
    expect(result.averages.propertyCare).toBe(3.67)
    expect(result.recentComments).toEqual(['new', 'old'])
  })
})

describe('maskDisplayName', () => {
  it('shows first name and last initial only', () => {
    expect(maskDisplayName('Ada Okafor')).toBe('Ada O.')
    expect(maskDisplayName('  Ada   Chinwe  Okafor ')).toBe('Ada O.')
  })

  it('keeps a single name as it is', () => {
    expect(maskDisplayName('Ada')).toBe('Ada')
  })

  it('never reveals an email address or a missing name', () => {
    expect(maskDisplayName('ada@example.com')).toBe('Tenant')
    expect(maskDisplayName('')).toBe('Tenant')
    expect(maskDisplayName(undefined)).toBe('Tenant')
  })
})

describe('share tokens', () => {
  it('generates 128-bit tokens as 32 lowercase hex characters', () => {
    const token = generateShareToken()
    expect(token).toMatch(/^[a-f0-9]{32}$/)
    expect(generateShareToken()).not.toBe(token)
  })

  it('hashes deterministically and never returns the raw token', () => {
    const token = generateShareToken()
    const hash = hashShareToken(token)
    expect(hash).toBe(hashShareToken(token))
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hash).not.toContain(token)
  })

  it('computes expiry from the TTL in days', () => {
    const now = new Date('2026-10-01T00:00:00Z')
    expect(shareExpiryFrom(now, 7).toISOString()).toBe('2026-10-08T00:00:00.000Z')
  })
})
