import crypto from 'crypto'
import { getPool } from '../db.js'
import {
  UserRiskState,
  CreateUserRiskStateInput,
  UpdateUserRiskStateInput,
  UserRiskStateEvent,
  UserRiskStateEventType,
  UserRiskStateStore,
  FreezeReason,
} from './userRiskState.js'

/**
 * Event type for a change, given the state before and after it.
 * Transitions into or out of frozen get their own type; anything else is UPDATED.
 */
function eventTypeFor(wasFrozen: boolean, isFrozen: boolean): UserRiskStateEventType {
  if (!wasFrozen && isFrozen) return 'FROZEN'
  if (wasFrozen && !isFrozen) return 'UNFROZEN'
  return 'UPDATED'
}

/**
 * In-memory implementation of UserRiskStateStore. Used when DATABASE_URL is not set.
 * State is lost on restart and not shared between instances.
 */
export class InMemoryUserRiskStateStore implements UserRiskStateStore {
  private riskStates: Map<string, UserRiskState> = new Map()
  private events: UserRiskStateEvent[] = []

  async create(input: CreateUserRiskStateInput): Promise<UserRiskState> {
    const existing = this.riskStates.get(input.userId)
    if (existing) {
      throw new Error(`Risk state already exists for user ${input.userId}`)
    }

    const now = new Date()
    const riskState: UserRiskState = {
      userId: input.userId,
      isFrozen: input.isFrozen,
      freezeReason: input.freezeReason,
      frozenAt: input.isFrozen ? now : null,
      unfrozenAt: null,
      notes: input.notes || null,
      createdAt: now,
      updatedAt: now,
    }

    this.riskStates.set(input.userId, riskState)
    this.recordEvent(input.userId, eventTypeFor(false, input.isFrozen), riskState, input.actorId)
    return riskState
  }

  async getByUserId(userId: string): Promise<UserRiskState | null> {
    return this.riskStates.get(userId) || null
  }

  async update(userId: string, input: UpdateUserRiskStateInput): Promise<UserRiskState> {
    const existing = this.riskStates.get(userId)
    if (!existing) {
      throw new Error(`Risk state not found for user ${userId}`)
    }

    const now = new Date()
    const updated: UserRiskState = {
      ...existing,
      isFrozen: input.isFrozen,
      freezeReason: input.freezeReason,
      frozenAt: input.isFrozen && !existing.isFrozen ? now : existing.frozenAt,
      unfrozenAt: !input.isFrozen && existing.isFrozen ? now : existing.unfrozenAt,
      notes: input.notes !== undefined ? input.notes : existing.notes,
      updatedAt: now,
    }

    this.riskStates.set(userId, updated)
    this.recordEvent(userId, eventTypeFor(existing.isFrozen, updated.isFrozen), updated, input.actorId)
    return updated
  }

  async freeze(userId: string, reason: FreezeReason, notes?: string, actorId?: string): Promise<UserRiskState> {
    const existing = await this.getByUserId(userId)

    if (existing) {
      return this.update(userId, {
        isFrozen: true,
        freezeReason: reason,
        notes: notes || existing.notes,
        actorId,
      })
    }

    return this.create({
      userId,
      isFrozen: true,
      freezeReason: reason,
      notes,
      actorId,
    })
  }

  async unfreeze(userId: string, notes?: string, actorId?: string): Promise<UserRiskState> {
    const existing = await this.getByUserId(userId)
    if (!existing) {
      throw new Error(`Risk state not found for user ${userId}`)
    }

    return this.update(userId, {
      isFrozen: false,
      freezeReason: null,
      notes: notes || existing.notes,
      actorId,
    })
  }

  async getAllFrozen(): Promise<UserRiskState[]> {
    return Array.from(this.riskStates.values()).filter((state) => state.isFrozen)
  }

  async getHistory(userId: string): Promise<UserRiskStateEvent[]> {
    return this.events.filter((e) => e.userId === userId)
  }

  private recordEvent(
    userId: string,
    eventType: UserRiskStateEventType,
    state: UserRiskState,
    actorId?: string,
  ): void {
    this.events.push({
      eventId: crypto.randomUUID(),
      userId,
      eventType,
      freezeReason: state.freezeReason,
      notes: state.notes,
      actorId: actorId ?? null,
      createdAt: new Date(),
    })
  }

  // Helper method for testing/cleanup
  clear(): void {
    this.riskStates.clear()
    this.events = []
  }

  // Helper method to get all risk states (for testing)
  getAll(): UserRiskState[] {
    return Array.from(this.riskStates.values())
  }
}

/**
 * PostgreSQL implementation. Every write runs in one transaction with a row
 * lock on user_risk_states, and appends to user_risk_state_events. Reads go
 * straight to the database, so a freeze applies to every instance at once.
 */
export class PostgresUserRiskStateStore implements UserRiskStateStore {
  async create(input: CreateUserRiskStateInput): Promise<UserRiskState> {
    return this.write(input.userId, input.actorId, (existing) => {
      if (existing) {
        throw new Error(`Risk state already exists for user ${input.userId}`)
      }
      return { isFrozen: input.isFrozen, freezeReason: input.freezeReason, notes: input.notes || null }
    })
  }

  async getByUserId(userId: string): Promise<UserRiskState | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const { rows } = await pool.query(`SELECT * FROM user_risk_states WHERE user_id = $1`, [userId])
    return rows[0] ? this.mapRow(rows[0]) : null
  }

  async update(userId: string, input: UpdateUserRiskStateInput): Promise<UserRiskState> {
    return this.write(userId, input.actorId, (existing) => {
      if (!existing) {
        throw new Error(`Risk state not found for user ${userId}`)
      }
      return {
        isFrozen: input.isFrozen,
        freezeReason: input.freezeReason,
        notes: input.notes !== undefined ? input.notes : existing.notes,
      }
    })
  }

  async freeze(userId: string, reason: FreezeReason, notes?: string, actorId?: string): Promise<UserRiskState> {
    return this.write(userId, actorId, (existing) => ({
      isFrozen: true,
      freezeReason: reason,
      notes: notes || existing?.notes || null,
    }))
  }

  async unfreeze(userId: string, notes?: string, actorId?: string): Promise<UserRiskState> {
    return this.write(userId, actorId, (existing) => {
      if (!existing) {
        throw new Error(`Risk state not found for user ${userId}`)
      }
      return {
        isFrozen: false,
        freezeReason: null,
        notes: notes || existing.notes,
      }
    })
  }

  async getAllFrozen(): Promise<UserRiskState[]> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const { rows } = await pool.query(
      `SELECT * FROM user_risk_states WHERE is_frozen = TRUE ORDER BY user_id ASC`,
    )
    return rows.map((row) => this.mapRow(row))
  }

  async getHistory(userId: string): Promise<UserRiskStateEvent[]> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const { rows } = await pool.query(
      `SELECT * FROM user_risk_state_events WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
      [userId],
    )
    return rows.map((row) => ({
      eventId: row.id,
      userId: row.user_id,
      eventType: row.event_type,
      freezeReason: row.freeze_reason ?? null,
      notes: row.notes ?? null,
      actorId: row.actor_id ?? null,
      createdAt: new Date(row.created_at),
    }))
  }

  /**
   * Locks the user's row (if any), computes the next state from it, writes the
   * row and an event, and commits. A concurrent change waits on the row lock.
   */
  private async write(
    userId: string,
    actorId: string | undefined,
    compute: (existing: UserRiskState | null) => {
      isFrozen: boolean
      freezeReason: FreezeReason | null
      notes: string | null | undefined
    },
  ): Promise<UserRiskState> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not initialized')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const { rows: currentRows } = await client.query(
        `SELECT * FROM user_risk_states WHERE user_id = $1 FOR UPDATE`,
        [userId],
      )
      const existing = currentRows[0] ? this.mapRow(currentRows[0]) : null
      const next = compute(existing)
      const now = new Date()
      const wasFrozen = existing?.isFrozen ?? false
      const eventType = eventTypeFor(wasFrozen, next.isFrozen)
      const frozenNow = next.isFrozen && !wasFrozen
      const unfrozenNow = !next.isFrozen && wasFrozen

      const notes = next.notes === undefined ? existing?.notes ?? null : next.notes

      if (!existing) {
        await client.query(
          `INSERT INTO user_risk_states
             (user_id, is_frozen, freeze_reason, notes, frozen_at, frozen_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [
            userId,
            next.isFrozen,
            next.freezeReason,
            notes,
            next.isFrozen ? now : null,
            next.isFrozen ? actorId ?? null : null,
            now,
          ],
        )
      } else {
        await client.query(
          `UPDATE user_risk_states
             SET is_frozen = $2,
                 freeze_reason = $3,
                 notes = $4,
                 frozen_at = $5,
                 frozen_by = $6,
                 unfrozen_at = $7,
                 unfrozen_by = $8,
                 updated_at = $9
           WHERE user_id = $1`,
          [
            userId,
            next.isFrozen,
            next.freezeReason,
            notes,
            frozenNow ? now : existing.frozenAt,
            frozenNow ? actorId ?? null : existing.frozenBy ?? null,
            unfrozenNow ? now : existing.unfrozenAt,
            unfrozenNow ? actorId ?? null : existing.unfrozenBy ?? null,
            now,
          ],
        )
      }

      await client.query(
        `INSERT INTO user_risk_state_events
           (user_id, event_type, freeze_reason, notes, actor_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, eventType, next.freezeReason, notes, actorId ?? null, now],
      )

      await client.query('COMMIT')

      return {
        userId,
        isFrozen: next.isFrozen,
        freezeReason: next.freezeReason,
        frozenAt: next.isFrozen ? (frozenNow ? now : existing?.frozenAt ?? null) : existing?.frozenAt ?? null,
        unfrozenAt: unfrozenNow ? now : existing?.unfrozenAt ?? null,
        notes,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  private mapRow(row: any): UserRiskState & { frozenBy?: string | null; unfrozenBy?: string | null } {
    return {
      userId: row.user_id,
      isFrozen: row.is_frozen,
      freezeReason: row.freeze_reason ?? null,
      frozenAt: row.frozen_at ? new Date(row.frozen_at) : null,
      unfrozenAt: row.unfrozen_at ? new Date(row.unfrozen_at) : null,
      notes: row.notes ?? null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      frozenBy: row.frozen_by ?? null,
      unfrozenBy: row.unfrozen_by ?? null,
    }
  }
}

// Singleton used by the app. Swapped to Postgres at startup when DATABASE_URL is set.
let userRiskStateStore: UserRiskStateStore = new InMemoryUserRiskStateStore()

export function initUserRiskStateStore(store: UserRiskStateStore): void {
  userRiskStateStore = store
}

export { userRiskStateStore }
