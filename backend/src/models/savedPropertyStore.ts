/**
 * Tenant saved-property store (#1889). Backed by `tenant_saved_properties`
 * (migrations/20261019140000). Save and remove are idempotent.
 */

import { getPool } from '../db.js'

export interface SavedPropertyStore {
  /** Listing ids the user has saved, most recently saved first. */
  listListingIds(userId: string): Promise<string[]>
  /** Saves a listing. Saving it again changes nothing. */
  save(userId: string, listingId: string): Promise<void>
  /** Removes a saved listing. Removing one that is not saved changes nothing. */
  remove(userId: string, listingId: string): Promise<void>
}

/**
 * In-memory implementation, used when DATABASE_URL is not set and in tests.
 */
export class InMemorySavedPropertyStore implements SavedPropertyStore {
  private saved = new Map<string, Map<string, number>>()
  private sequence = 0

  async listListingIds(userId: string): Promise<string[]> {
    const entries = this.saved.get(userId)
    if (!entries) return []
    return [...entries.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([listingId]) => listingId)
  }

  async save(userId: string, listingId: string): Promise<void> {
    let entries = this.saved.get(userId)
    if (!entries) {
      entries = new Map()
      this.saved.set(userId, entries)
    }
    if (!entries.has(listingId)) {
      entries.set(listingId, ++this.sequence)
    }
  }

  async remove(userId: string, listingId: string): Promise<void> {
    this.saved.get(userId)?.delete(listingId)
  }

  // Test helper
  async clear(): Promise<void> {
    this.saved.clear()
    this.sequence = 0
  }
}

/**
 * PostgreSQL implementation.
 */
export class PostgresSavedPropertyStore implements SavedPropertyStore {
  private async pool() {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    return pool
  }

  async listListingIds(userId: string): Promise<string[]> {
    const pool = await this.pool()
    const result = await pool.query(
      `SELECT listing_id FROM tenant_saved_properties
       WHERE user_id = $1
       ORDER BY created_at DESC, listing_id`,
      [userId],
    )
    return result.rows.map((row: { listing_id: string }) => row.listing_id)
  }

  async save(userId: string, listingId: string): Promise<void> {
    const pool = await this.pool()
    await pool.query(
      `INSERT INTO tenant_saved_properties (user_id, listing_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, listing_id) DO NOTHING`,
      [userId, listingId],
    )
  }

  async remove(userId: string, listingId: string): Promise<void> {
    const pool = await this.pool()
    await pool.query(
      `DELETE FROM tenant_saved_properties WHERE user_id = $1 AND listing_id = $2`,
      [userId, listingId],
    )
  }
}

let savedPropertyStore: SavedPropertyStore = new InMemorySavedPropertyStore()

export function initSavedPropertyStore(store: SavedPropertyStore): void {
  savedPropertyStore = store
}

export { savedPropertyStore }
