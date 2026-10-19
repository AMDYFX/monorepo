/**
 * Inspection Job Store — #1903
 *
 * Reads and writes `inspection_jobs` and `inspection_reports` (migrations/029).
 *
 * Race safety: claim() is one conditional UPDATE (status = 'available'), and
 * submitReport() is one statement that updates the job and inserts its report,
 * so two inspectors racing for a job leave exactly one winner, and a report never
 * lands without its job transition.
 */

import { randomUUID } from 'node:crypto'
import { getPool } from '../db.js'
import { listingStore } from './listingStore.js'
import { isClaimLive } from '../services/inspectionJobs.js'

export type InspectionJobStatus =
  | 'available'
  | 'claimed'
  | 'in_progress'
  | 'submitted'
  | 'approved'
  | 'rejected'

export interface InspectionJob {
  id: string
  listingId: string
  inspectorId: string | null
  status: InspectionJobStatus
  offeredFeeNgn: number
  claimDeadline: Date | null
  submittedAt: Date | null
  approvedAt: Date | null
  rejectionReason: string | null
  createdAt: Date
  updatedAt: Date
}

export interface InspectionJobDetail extends InspectionJob {
  listingArea: string | null
}

export interface InspectionReportInput {
  overallGrade: 'A' | 'B' | 'C' | 'D'
  roomChecklist: Record<string, unknown>
  photoKeys: string[]
  notes: string
}

export interface InspectionJobStore {
  create(input: { listingId: string; offeredFeeNgn: number; now: Date }): Promise<InspectionJob>
  findById(jobId: string): Promise<InspectionJobDetail | null>
  /** An available, claimed or submitted job for the listing, if one exists. */
  findOpenForListing(listingId: string): Promise<InspectionJob | null>
  /** Available jobs whose listing area is one of `areas` (case-insensitive). */
  listAvailable(areas: string[]): Promise<InspectionJobDetail[]>
  listForInspector(inspectorId: string): Promise<InspectionJobDetail[]>
  listByStatus(status?: InspectionJobStatus): Promise<InspectionJobDetail[]>
  /** Atomically moves an available job to claimed. Returns null when it is not available. */
  claim(jobId: string, inspectorId: string, claimDeadline: Date, now: Date): Promise<InspectionJob | null>
  /** Returns claimed jobs past their deadline to available. Returns the number released. */
  releaseExpiredClaims(now: Date): Promise<number>
  /** Records the report and moves the job to submitted, only while the inspector's claim is live. */
  submitReport(jobId: string, inspectorId: string, report: InspectionReportInput, now: Date): Promise<boolean>
  /** Approves or rejects a submitted job. Returns null when the job is not submitted. */
  review(
    jobId: string,
    decision: 'approved' | 'rejected',
    now: Date,
    rejectionReason?: string,
  ): Promise<InspectionJob | null>
}

async function defaultListingArea(listingId: string): Promise<string | null> {
  const listing = await listingStore.getById(listingId)
  return listing?.area ?? null
}

/**
 * In-memory implementation for testing
 */
export class InMemoryInspectionJobStore implements InspectionJobStore {
  private jobs = new Map<string, InspectionJob>()
  private reports = new Map<string, InspectionReportInput & { jobId: string; submittedAt: Date }>()

  constructor(private resolveListingArea: (listingId: string) => Promise<string | null> = defaultListingArea) {}

  async create(input: { listingId: string; offeredFeeNgn: number; now: Date }): Promise<InspectionJob> {
    const job: InspectionJob = {
      id: randomUUID(),
      listingId: input.listingId,
      inspectorId: null,
      status: 'available',
      offeredFeeNgn: input.offeredFeeNgn,
      claimDeadline: null,
      submittedAt: null,
      approvedAt: null,
      rejectionReason: null,
      createdAt: input.now,
      updatedAt: input.now,
    }
    this.jobs.set(job.id, job)
    return { ...job }
  }

  async findById(jobId: string): Promise<InspectionJobDetail | null> {
    const job = this.jobs.get(jobId)
    return job ? this.withArea(job) : null
  }

  async findOpenForListing(listingId: string): Promise<InspectionJob | null> {
    const open = Array.from(this.jobs.values()).find(
      (job) =>
        job.listingId === listingId &&
        (job.status === 'available' || job.status === 'claimed' || job.status === 'submitted'),
    )
    return open ? { ...open } : null
  }

  async listAvailable(areas: string[]): Promise<InspectionJobDetail[]> {
    const wanted = new Set(areas.map((area) => area.trim().toLowerCase()))
    if (wanted.size === 0) return []
    const available = Array.from(this.jobs.values()).filter((job) => job.status === 'available')
    const detailed = await Promise.all(available.map((job) => this.withArea(job)))
    return detailed
      .filter((job) => job.listingArea !== null && wanted.has(job.listingArea.trim().toLowerCase()))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  }

  async listForInspector(inspectorId: string): Promise<InspectionJobDetail[]> {
    const mine = Array.from(this.jobs.values())
      .filter((job) => job.inspectorId === inspectorId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    return Promise.all(mine.map((job) => this.withArea(job)))
  }

  async listByStatus(status?: InspectionJobStatus): Promise<InspectionJobDetail[]> {
    const matching = Array.from(this.jobs.values())
      .filter((job) => !status || job.status === status)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    return Promise.all(matching.map((job) => this.withArea(job)))
  }

  // No await between the status check and the write, so concurrent callers cannot both win.
  async claim(jobId: string, inspectorId: string, claimDeadline: Date, now: Date): Promise<InspectionJob | null> {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'available') return null
    job.status = 'claimed'
    job.inspectorId = inspectorId
    job.claimDeadline = claimDeadline
    job.updatedAt = now
    return { ...job }
  }

  async releaseExpiredClaims(now: Date): Promise<number> {
    let released = 0
    for (const job of this.jobs.values()) {
      if (job.status === 'claimed' && job.claimDeadline !== null && job.claimDeadline.getTime() <= now.getTime()) {
        job.status = 'available'
        job.inspectorId = null
        job.claimDeadline = null
        job.updatedAt = now
        released++
      }
    }
    return released
  }

  async submitReport(
    jobId: string,
    inspectorId: string,
    report: InspectionReportInput,
    now: Date,
  ): Promise<boolean> {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'claimed' || job.inspectorId !== inspectorId || !isClaimLive(job.claimDeadline, now)) {
      return false
    }
    job.status = 'submitted'
    job.submittedAt = now
    job.updatedAt = now
    this.reports.set(jobId, { ...report, jobId, submittedAt: now })
    return true
  }

  async review(
    jobId: string,
    decision: 'approved' | 'rejected',
    now: Date,
    rejectionReason?: string,
  ): Promise<InspectionJob | null> {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'submitted') return null
    job.status = decision
    job.updatedAt = now
    if (decision === 'approved') {
      job.approvedAt = now
      job.rejectionReason = null
    } else {
      job.approvedAt = null
      job.rejectionReason = rejectionReason ?? null
    }
    return { ...job }
  }

  private async withArea(job: InspectionJob): Promise<InspectionJobDetail> {
    return { ...job, listingArea: await this.resolveListingArea(job.listingId) }
  }

  // Test helper
  async clear(): Promise<void> {
    this.jobs.clear()
    this.reports.clear()
  }
}

const JOB_COLUMNS = `j.id, j.listing_id, j.inspector_id, j.status, j.offered_fee_ngn,
       j.claim_deadline, j.submitted_at, j.approved_at, j.rejection_reason,
       j.created_at, j.updated_at`

/**
 * PostgreSQL implementation
 */
export class PostgresInspectionJobStore implements InspectionJobStore {
  async create(input: { listingId: string; offeredFeeNgn: number; now: Date }): Promise<InspectionJob> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `INSERT INTO inspection_jobs (listing_id, offered_fee_ngn, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       RETURNING id, listing_id, inspector_id, status, offered_fee_ngn, claim_deadline,
                 submitted_at, approved_at, rejection_reason, created_at, updated_at`,
      [input.listingId, input.offeredFeeNgn, input.now],
    )
    return this.mapJob(result.rows[0])
  }

  async findById(jobId: string): Promise<InspectionJobDetail | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `SELECT ${JOB_COLUMNS}, l.area AS listing_area
       FROM inspection_jobs j
       LEFT JOIN whistleblower_listings l ON l.listing_id = j.listing_id
       WHERE j.id = $1`,
      [jobId],
    )
    return result.rows[0] ? this.mapDetail(result.rows[0]) : null
  }

  async findOpenForListing(listingId: string): Promise<InspectionJob | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `SELECT id, listing_id, inspector_id, status, offered_fee_ngn, claim_deadline,
              submitted_at, approved_at, rejection_reason, created_at, updated_at
       FROM inspection_jobs
       WHERE listing_id = $1 AND status IN ('available', 'claimed', 'submitted')
       LIMIT 1`,
      [listingId],
    )
    return result.rows[0] ? this.mapJob(result.rows[0]) : null
  }

  async listAvailable(areas: string[]): Promise<InspectionJobDetail[]> {
    const normalized = areas.map((area) => area.trim().toLowerCase()).filter(Boolean)
    if (normalized.length === 0) return []
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `SELECT ${JOB_COLUMNS}, l.area AS listing_area
       FROM inspection_jobs j
       JOIN whistleblower_listings l ON l.listing_id = j.listing_id
       WHERE j.status = 'available' AND lower(l.area) = ANY($1::text[])
       ORDER BY j.created_at ASC`,
      [normalized],
    )
    return result.rows.map((row: any) => this.mapDetail(row))
  }

  async listForInspector(inspectorId: string): Promise<InspectionJobDetail[]> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `SELECT ${JOB_COLUMNS}, l.area AS listing_area
       FROM inspection_jobs j
       LEFT JOIN whistleblower_listings l ON l.listing_id = j.listing_id
       WHERE j.inspector_id = $1
       ORDER BY j.updated_at DESC`,
      [inspectorId],
    )
    return result.rows.map((row: any) => this.mapDetail(row))
  }

  async listByStatus(status?: InspectionJobStatus): Promise<InspectionJobDetail[]> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `SELECT ${JOB_COLUMNS}, l.area AS listing_area
       FROM inspection_jobs j
       LEFT JOIN whistleblower_listings l ON l.listing_id = j.listing_id
       WHERE ($1::text IS NULL OR j.status = $1)
       ORDER BY j.created_at ASC`,
      [status ?? null],
    )
    return result.rows.map((row: any) => this.mapDetail(row))
  }

  async claim(jobId: string, inspectorId: string, claimDeadline: Date, now: Date): Promise<InspectionJob | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `UPDATE inspection_jobs
       SET status = 'claimed', inspector_id = $2, claim_deadline = $3, updated_at = $4
       WHERE id = $1 AND status = 'available'
       RETURNING id, listing_id, inspector_id, status, offered_fee_ngn, claim_deadline,
                 submitted_at, approved_at, rejection_reason, created_at, updated_at`,
      [jobId, inspectorId, claimDeadline, now],
    )
    return result.rows[0] ? this.mapJob(result.rows[0]) : null
  }

  async releaseExpiredClaims(now: Date): Promise<number> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `UPDATE inspection_jobs
       SET status = 'available', inspector_id = NULL, claim_deadline = NULL, updated_at = $1
       WHERE status = 'claimed' AND claim_deadline <= $1`,
      [now],
    )
    return result.rowCount ?? 0
  }

  async submitReport(
    jobId: string,
    inspectorId: string,
    report: InspectionReportInput,
    now: Date,
  ): Promise<boolean> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `WITH submitted AS (
         UPDATE inspection_jobs
         SET status = 'submitted', submitted_at = $3, updated_at = $3
         WHERE id = $1 AND inspector_id = $2 AND status = 'claimed' AND claim_deadline > $3
         RETURNING id
       )
       INSERT INTO inspection_reports (job_id, overall_grade, room_checklist, photo_keys, notes, submitted_at)
       SELECT id, $4, $5::jsonb, $6::text[], $7, $3 FROM submitted
       RETURNING id`,
      [
        jobId,
        inspectorId,
        now,
        report.overallGrade,
        JSON.stringify(report.roomChecklist),
        report.photoKeys,
        report.notes,
      ],
    )
    return (result.rowCount ?? 0) > 0
  }

  async review(
    jobId: string,
    decision: 'approved' | 'rejected',
    now: Date,
    rejectionReason?: string,
  ): Promise<InspectionJob | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `UPDATE inspection_jobs
       SET status = $2,
           approved_at = CASE WHEN $2 = 'approved' THEN $3::timestamptz ELSE NULL END,
           rejection_reason = CASE WHEN $2 = 'rejected' THEN $4 ELSE NULL END,
           updated_at = $3
       WHERE id = $1 AND status = 'submitted'
       RETURNING id, listing_id, inspector_id, status, offered_fee_ngn, claim_deadline,
                 submitted_at, approved_at, rejection_reason, created_at, updated_at`,
      [jobId, decision, now, rejectionReason ?? null],
    )
    return result.rows[0] ? this.mapJob(result.rows[0]) : null
  }

  private mapJob(row: any): InspectionJob {
    return {
      id: row.id,
      listingId: row.listing_id,
      inspectorId: row.inspector_id ?? null,
      status: row.status,
      offeredFeeNgn: Number(row.offered_fee_ngn),
      claimDeadline: row.claim_deadline ? new Date(row.claim_deadline) : null,
      submittedAt: row.submitted_at ? new Date(row.submitted_at) : null,
      approvedAt: row.approved_at ? new Date(row.approved_at) : null,
      rejectionReason: row.rejection_reason ?? null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }
  }

  private mapDetail(row: any): InspectionJobDetail {
    return { ...this.mapJob(row), listingArea: row.listing_area ?? null }
  }
}

let inspectionJobStore: InspectionJobStore = new InMemoryInspectionJobStore()

export function initInspectionJobStore(store: InspectionJobStore): void {
  inspectionJobStore = store
}

export { inspectionJobStore }
