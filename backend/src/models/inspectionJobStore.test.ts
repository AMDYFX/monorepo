import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryInspectionJobStore, type InspectionReportInput } from './inspectionJobStore.js'

const LISTING_AREAS: Record<string, string> = {
  'listing-lekki': 'Lekki',
  'listing-yaba': 'Yaba',
}

const REPORT: InspectionReportInput = {
  overallGrade: 'B',
  roomChecklist: { kitchen: 'ok' },
  photoKeys: ['inspection-reports/job/a.jpg', 'inspection-reports/job/b.jpg', 'inspection-reports/job/c.jpg'],
  notes: 'Walls need repainting but plumbing is sound.',
}

const T0 = new Date('2026-10-20T10:00:00Z')
const HOUR = 60 * 60 * 1000
const DEADLINE = new Date(T0.getTime() + 48 * HOUR)

describe('InMemoryInspectionJobStore', () => {
  let store: InMemoryInspectionJobStore

  beforeEach(() => {
    store = new InMemoryInspectionJobStore(async (listingId) => LISTING_AREAS[listingId] ?? null)
  })

  it('lets exactly one of several racing inspectors claim a job', async () => {
    const job = await store.create({ listingId: 'listing-lekki', offeredFeeNgn: 15000, now: T0 })

    const results = await Promise.all(
      ['inspector-a', 'inspector-b', 'inspector-c'].map((inspectorId) =>
        store.claim(job.id, inspectorId, DEADLINE, T0),
      ),
    )

    const winners = results.filter((result) => result !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]?.status).toBe('claimed')
    const stored = await store.findById(job.id)
    expect(stored?.inspectorId).toBe(winners[0]?.inspectorId)
  })

  it('releases a claim once its deadline passes, and not before', async () => {
    const job = await store.create({ listingId: 'listing-lekki', offeredFeeNgn: 15000, now: T0 })
    await store.claim(job.id, 'inspector-a', DEADLINE, T0)

    expect(await store.releaseExpiredClaims(new Date(DEADLINE.getTime() - 1))).toBe(0)
    expect((await store.findById(job.id))?.status).toBe('claimed')

    expect(await store.releaseExpiredClaims(DEADLINE)).toBe(1)
    const released = await store.findById(job.id)
    expect(released?.status).toBe('available')
    expect(released?.inspectorId).toBeNull()
    expect(released?.claimDeadline).toBeNull()
  })

  it('refuses a report from a lapsed claim, even before the expiry job runs', async () => {
    const job = await store.create({ listingId: 'listing-lekki', offeredFeeNgn: 15000, now: T0 })
    await store.claim(job.id, 'inspector-a', DEADLINE, T0)

    const afterDeadline = new Date(DEADLINE.getTime() + HOUR)
    expect(await store.submitReport(job.id, 'inspector-a', REPORT, afterDeadline)).toBe(false)
    expect((await store.findById(job.id))?.status).toBe('claimed')
  })

  it('accepts a report only from the inspector holding a live claim', async () => {
    const job = await store.create({ listingId: 'listing-lekki', offeredFeeNgn: 15000, now: T0 })
    await store.claim(job.id, 'inspector-a', DEADLINE, T0)

    expect(await store.submitReport(job.id, 'inspector-b', REPORT, T0)).toBe(false)
    expect(await store.submitReport(job.id, 'inspector-a', REPORT, T0)).toBe(true)
    expect((await store.findById(job.id))?.status).toBe('submitted')
  })

  it('reviews only submitted jobs', async () => {
    const job = await store.create({ listingId: 'listing-lekki', offeredFeeNgn: 15000, now: T0 })
    expect(await store.review(job.id, 'approved', T0)).toBeNull()

    await store.claim(job.id, 'inspector-a', DEADLINE, T0)
    await store.submitReport(job.id, 'inspector-a', REPORT, T0)

    const rejected = await store.review(job.id, 'rejected', T0, 'Photos do not match the listing')
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.rejectionReason).toBe('Photos do not match the listing')
    expect(await store.review(job.id, 'approved', T0)).toBeNull()
  })

  it('lists only available jobs in the requested areas, case-insensitively', async () => {
    await store.create({ listingId: 'listing-lekki', offeredFeeNgn: 15000, now: T0 })
    await store.create({ listingId: 'listing-yaba', offeredFeeNgn: 12000, now: T0 })

    const lekki = await store.listAvailable(['lekki'])
    expect(lekki.map((job) => job.listingArea)).toEqual(['Lekki'])
    expect(await store.listAvailable([])).toEqual([])
  })
})
