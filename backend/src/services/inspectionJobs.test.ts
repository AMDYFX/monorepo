import { describe, expect, it } from 'vitest'
import {
  claimDeadlineFrom,
  DEFAULT_CLAIM_WINDOW_HOURS,
  getClaimWindowMs,
  isClaimLive,
  isInServiceArea,
  photoKeysBelongToJob,
} from './inspectionJobs.js'
import {
  createInspectionJobSchema,
  submitInspectionReportSchema,
} from '../schemas/inspectionJobs.js'

const HOUR = 60 * 60 * 1000

describe('getClaimWindowMs', () => {
  it('defaults to 48 hours', () => {
    expect(getClaimWindowMs({})).toBe(DEFAULT_CLAIM_WINDOW_HOURS * HOUR)
    expect(DEFAULT_CLAIM_WINDOW_HOURS).toBe(48)
  })

  it('honours INSPECTION_CLAIM_WINDOW_HOURS and ignores invalid values', () => {
    expect(getClaimWindowMs({ INSPECTION_CLAIM_WINDOW_HOURS: '12' })).toBe(12 * HOUR)
    expect(getClaimWindowMs({ INSPECTION_CLAIM_WINDOW_HOURS: 'soon' })).toBe(48 * HOUR)
    expect(getClaimWindowMs({ INSPECTION_CLAIM_WINDOW_HOURS: '-3' })).toBe(48 * HOUR)
  })
})

describe('claim deadlines', () => {
  it('computes the deadline from the claim time', () => {
    const now = new Date('2026-10-20T10:00:00Z')
    expect(claimDeadlineFrom(now, 48 * HOUR).toISOString()).toBe('2026-10-22T10:00:00.000Z')
  })

  it('treats a claim as live only before its deadline', () => {
    const deadline = new Date('2026-10-22T10:00:00Z')
    expect(isClaimLive(deadline, new Date('2026-10-22T09:59:59Z'))).toBe(true)
    expect(isClaimLive(deadline, deadline)).toBe(false)
    expect(isClaimLive(null, new Date('2026-10-01T00:00:00Z'))).toBe(false)
  })
})

describe('isInServiceArea', () => {
  it('matches case-insensitively against the inspector service areas', () => {
    expect(isInServiceArea('lekki', ['Lekki', 'Yaba'])).toBe(true)
    expect(isInServiceArea(' Yaba ', ['Lekki', 'Yaba'])).toBe(true)
    expect(isInServiceArea('Abuja', ['Lekki', 'Yaba'])).toBe(false)
  })

  it('never matches a listing with no area', () => {
    expect(isInServiceArea(null, ['Lekki'])).toBe(false)
    expect(isInServiceArea(undefined, ['Lekki'])).toBe(false)
  })
})

describe('photoKeysBelongToJob', () => {
  const JOB_ID = '6f1c1a52-6e0e-4a53-9a51-2f3b1d2c0e11'

  it('accepts keys issued for this job', () => {
    expect(
      photoKeysBelongToJob(JOB_ID, [`inspection-reports/${JOB_ID}/one.jpg`, `inspection-reports/${JOB_ID}/two.png`]),
    ).toBe(true)
  })

  it('rejects keys from another job, other prefixes, or path traversal', () => {
    expect(photoKeysBelongToJob(JOB_ID, ['inspection-reports/other-job/one.jpg'])).toBe(false)
    expect(photoKeysBelongToJob(JOB_ID, ['tenant-documents/one.jpg'])).toBe(false)
    expect(photoKeysBelongToJob(JOB_ID, [`inspection-reports/${JOB_ID}/../../secret.jpg`])).toBe(false)
  })
})

describe('inspection report schema (mirrors inspection_reports constraints)', () => {
  const valid = {
    overallGrade: 'A',
    roomChecklist: { kitchen: 'ok' },
    photoKeys: ['a', 'b', 'c'],
    notes: 'Twenty characters or more here.',
  }

  it('accepts a complete report', () => {
    expect(submitInspectionReportSchema.safeParse(valid).success).toBe(true)
  })

  it('requires at least three photos', () => {
    expect(submitInspectionReportSchema.safeParse({ ...valid, photoKeys: ['a', 'b'] }).success).toBe(false)
  })

  it('requires unique photo keys', () => {
    expect(submitInspectionReportSchema.safeParse({ ...valid, photoKeys: ['a', 'a', 'b'] }).success).toBe(false)
  })

  it('requires notes of at least 20 characters after trimming', () => {
    expect(submitInspectionReportSchema.safeParse({ ...valid, notes: '   too short   ' }).success).toBe(false)
  })

  it('only accepts grades A to D', () => {
    expect(submitInspectionReportSchema.safeParse({ ...valid, overallGrade: 'E' }).success).toBe(false)
  })
})

describe('createInspectionJobSchema fee validation', () => {
  const base = { listingId: '6f1c1a52-6e0e-4a53-9a51-2f3b1d2c0e11' }

  it('accepts fees with up to two decimal places, including float-sensitive values', () => {
    expect(createInspectionJobSchema.safeParse({ ...base, offeredFeeNgn: 19.99 }).success).toBe(true)
    expect(createInspectionJobSchema.safeParse({ ...base, offeredFeeNgn: 15000 }).success).toBe(true)
  })

  it('rejects fees with more than two decimal places or non-positive values', () => {
    expect(createInspectionJobSchema.safeParse({ ...base, offeredFeeNgn: 1.005 }).success).toBe(false)
    expect(createInspectionJobSchema.safeParse({ ...base, offeredFeeNgn: 0 }).success).toBe(false)
  })
})
