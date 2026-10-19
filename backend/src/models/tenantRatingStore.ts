/**
 * Tenant Rating Store — #1905
 *
 * Reads and writes `tenant_ratings` and `rating_card_tokens` (migrations/032).
 * `rating_card_tokens.token` holds the SHA-256 of the share token, never the token.
 */

import { randomUUID } from 'node:crypto'
import { getPool } from '../db.js'

export interface TenantRatingRecord {
  id: string
  tenantId: string
  landlordId: string
  dealId: string
  paymentTimeliness: number
  propertyCare: number
  communication: number
  overall: number
  comment: string | null
  createdAt: Date
}

export type NewTenantRating = Omit<TenantRatingRecord, 'id' | 'createdAt'>

export interface RatingCardShareRecord {
  id: string
  tenantId: string
  expiresAt: Date
  createdAt: Date
}

export class DuplicateTenantRatingError extends Error {
  constructor() {
    super('A rating already exists for this tenant, landlord and deal')
    this.name = 'DuplicateTenantRatingError'
  }
}

export interface TenantRatingStore {
  /** Throws DuplicateTenantRatingError when (tenant, landlord, deal) already has a rating. */
  createRating(input: NewTenantRating): Promise<TenantRatingRecord>
  listRatingsForTenant(tenantId: string): Promise<TenantRatingRecord[]>
  createShare(input: { tenantId: string; tokenHash: string; expiresAt: Date }): Promise<RatingCardShareRecord>
  findShareByTokenHash(tokenHash: string): Promise<RatingCardShareRecord | null>
  /** Deletes the share, which revokes its link. Returns false when no such share belongs to the tenant. */
  revokeShare(tenantId: string, shareId: string): Promise<boolean>
}

/**
 * In-memory implementation for testing
 */
export class InMemoryTenantRatingStore implements TenantRatingStore {
  private ratings = new Map<string, TenantRatingRecord>()
  private shares = new Map<string, RatingCardShareRecord & { tokenHash: string }>()

  async createRating(input: NewTenantRating): Promise<TenantRatingRecord> {
    const duplicate = Array.from(this.ratings.values()).some(
      (rating) =>
        rating.tenantId === input.tenantId &&
        rating.landlordId === input.landlordId &&
        rating.dealId === input.dealId,
    )
    if (duplicate) throw new DuplicateTenantRatingError()

    const record: TenantRatingRecord = { ...input, id: randomUUID(), createdAt: new Date() }
    this.ratings.set(record.id, record)
    return { ...record }
  }

  async listRatingsForTenant(tenantId: string): Promise<TenantRatingRecord[]> {
    return Array.from(this.ratings.values())
      .filter((rating) => rating.tenantId === tenantId)
      .map((rating) => ({ ...rating }))
  }

  async createShare(input: { tenantId: string; tokenHash: string; expiresAt: Date }): Promise<RatingCardShareRecord> {
    const share = {
      id: randomUUID(),
      tenantId: input.tenantId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
    }
    this.shares.set(share.id, share)
    return { id: share.id, tenantId: share.tenantId, expiresAt: share.expiresAt, createdAt: share.createdAt }
  }

  async findShareByTokenHash(tokenHash: string): Promise<RatingCardShareRecord | null> {
    const share = Array.from(this.shares.values()).find((s) => s.tokenHash === tokenHash)
    return share ? { id: share.id, tenantId: share.tenantId, expiresAt: share.expiresAt, createdAt: share.createdAt } : null
  }

  async revokeShare(tenantId: string, shareId: string): Promise<boolean> {
    const share = this.shares.get(shareId)
    if (!share || share.tenantId !== tenantId) return false
    this.shares.delete(shareId)
    return true
  }

  // Test helper
  async clear(): Promise<void> {
    this.ratings.clear()
    this.shares.clear()
  }
}

const RATING_COLUMNS = `id, tenant_id, landlord_id, deal_id, payment_timeliness, property_care,
       communication, overall, comment, created_at`

/**
 * PostgreSQL implementation
 */
export class PostgresTenantRatingStore implements TenantRatingStore {
  async createRating(input: NewTenantRating): Promise<TenantRatingRecord> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    try {
      const result = await pool.query(
        `INSERT INTO tenant_ratings
           (tenant_id, landlord_id, deal_id, payment_timeliness, property_care, communication, overall, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${RATING_COLUMNS}`,
        [
          input.tenantId,
          input.landlordId,
          input.dealId,
          input.paymentTimeliness,
          input.propertyCare,
          input.communication,
          input.overall,
          input.comment,
        ],
      )
      return this.mapRating(result.rows[0])
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DuplicateTenantRatingError()
      throw error
    }
  }

  async listRatingsForTenant(tenantId: string): Promise<TenantRatingRecord[]> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `SELECT ${RATING_COLUMNS}
       FROM tenant_ratings
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [tenantId],
    )
    return result.rows.map((row: any) => this.mapRating(row))
  }

  async createShare(input: { tenantId: string; tokenHash: string; expiresAt: Date }): Promise<RatingCardShareRecord> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `INSERT INTO rating_card_tokens (tenant_id, token, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, tenant_id, expires_at, created_at`,
      [input.tenantId, input.tokenHash, input.expiresAt],
    )
    return this.mapShare(result.rows[0])
  }

  async findShareByTokenHash(tokenHash: string): Promise<RatingCardShareRecord | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `SELECT id, tenant_id, expires_at, created_at
       FROM rating_card_tokens
       WHERE token = $1`,
      [tokenHash],
    )
    return result.rows[0] ? this.mapShare(result.rows[0]) : null
  }

  async revokeShare(tenantId: string, shareId: string): Promise<boolean> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `DELETE FROM rating_card_tokens
       WHERE id = $1 AND tenant_id = $2`,
      [shareId, tenantId],
    )
    return (result.rowCount ?? 0) > 0
  }

  private mapRating(row: any): TenantRatingRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      landlordId: row.landlord_id,
      dealId: row.deal_id,
      paymentTimeliness: row.payment_timeliness,
      propertyCare: row.property_care,
      communication: row.communication,
      overall: row.overall,
      comment: row.comment ?? null,
      createdAt: new Date(row.created_at),
    }
  }

  private mapShare(row: any): RatingCardShareRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
    }
  }
}

let tenantRatingStore: TenantRatingStore = new InMemoryTenantRatingStore()

export function initTenantRatingStore(store: TenantRatingStore): void {
  tenantRatingStore = store
}

export { tenantRatingStore }
