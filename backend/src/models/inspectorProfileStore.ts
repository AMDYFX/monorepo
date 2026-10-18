/**
 * Inspector Profile Store
 *
 * MINIMAL subset of #1902 (inspector onboarding & verification), built only so
 * that #1904 (property inspections) can tell whether a caller is a VERIFIED
 * inspector. It reads/writes `inspector_profiles` (migrations/040) and exposes:
 *   - getByUserId: used by the requireVerifiedInspector middleware
 *   - setVerificationStatus: used by the admin verification endpoint; upserts
 *     the profile row because there is no self-service onboarding yet.
 * Full onboarding (bio, service areas, documents, self-registration) is left
 * to #1902.
 */

import { getPool } from '../db.js'

export type InspectorVerificationStatus = 'pending' | 'verified' | 'suspended'

export interface InspectorProfile {
  userId: string
  verificationStatus: InspectorVerificationStatus
  createdAt: Date
  updatedAt: Date
}

export interface InspectorProfileStore {
  getByUserId(userId: string): Promise<InspectorProfile | null>
  setVerificationStatus(
    userId: string,
    status: InspectorVerificationStatus,
  ): Promise<InspectorProfile>
}

/**
 * In-memory implementation for testing
 */
export class InMemoryInspectorProfileStore implements InspectorProfileStore {
  private profiles: Map<string, InspectorProfile> = new Map()

  async getByUserId(userId: string): Promise<InspectorProfile | null> {
    const profile = this.profiles.get(userId)
    return profile ? { ...profile } : null
  }

  async setVerificationStatus(
    userId: string,
    status: InspectorVerificationStatus,
  ): Promise<InspectorProfile> {
    const now = new Date()
    const existing = this.profiles.get(userId)
    const profile: InspectorProfile = {
      userId,
      verificationStatus: status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.profiles.set(userId, profile)
    return { ...profile }
  }

  // Test helper
  async clear(): Promise<void> {
    this.profiles.clear()
  }
}

/**
 * PostgreSQL implementation
 */
export class PostgresInspectorProfileStore implements InspectorProfileStore {
  async getByUserId(userId: string): Promise<InspectorProfile | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `SELECT user_id, verification_status, created_at, updated_at
       FROM inspector_profiles
       WHERE user_id = $1`,
      [userId],
    )
    return result.rows[0] ? this.mapRow(result.rows[0]) : null
  }

  async setVerificationStatus(
    userId: string,
    status: InspectorVerificationStatus,
  ): Promise<InspectorProfile> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const result = await pool.query(
      `INSERT INTO inspector_profiles (user_id, verification_status)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET verification_status = EXCLUDED.verification_status,
             updated_at = NOW()
       RETURNING user_id, verification_status, created_at, updated_at`,
      [userId, status],
    )
    return this.mapRow(result.rows[0])
  }

  private mapRow(row: any): InspectorProfile {
    return {
      userId: row.user_id,
      verificationStatus: row.verification_status,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }
  }
}

// Singleton instance
let inspectorProfileStore: InspectorProfileStore =
  new InMemoryInspectorProfileStore()

export function initInspectorProfileStore(store: InspectorProfileStore): void {
  inspectorProfileStore = store
}

export { inspectorProfileStore }
