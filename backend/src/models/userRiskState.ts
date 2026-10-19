/**
 * User risk state model for tracking frozen accounts and compliance issues
 */

export type FreezeReason = 'NEGATIVE_BALANCE' | 'MANUAL' | 'COMPLIANCE'

export interface UserRiskState {
  userId: string
  isFrozen: boolean
  freezeReason: FreezeReason | null
  frozenAt: Date | null
  unfrozenAt: Date | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateUserRiskStateInput {
  userId: string
  isFrozen: boolean
  freezeReason: FreezeReason
  notes?: string
  /** Admin who made the change. Omit for system-initiated changes. */
  actorId?: string
}

export interface UpdateUserRiskStateInput {
  isFrozen: boolean
  freezeReason: FreezeReason | null
  notes?: string | null
  /** Admin who made the change. Omit for system-initiated changes. */
  actorId?: string
}

export type UserRiskStateEventType = 'FROZEN' | 'UNFROZEN' | 'UPDATED'

/** Append-only record of a freeze state change. */
export interface UserRiskStateEvent {
  eventId: string
  userId: string
  eventType: UserRiskStateEventType
  freezeReason: FreezeReason | null
  notes: string | null
  actorId: string | null
  createdAt: Date
}

export interface UserRiskStateStore {
  create(input: CreateUserRiskStateInput): Promise<UserRiskState>
  getByUserId(userId: string): Promise<UserRiskState | null>
  update(userId: string, input: UpdateUserRiskStateInput): Promise<UserRiskState>
  freeze(userId: string, reason: FreezeReason, notes?: string, actorId?: string): Promise<UserRiskState>
  unfreeze(userId: string, notes?: string, actorId?: string): Promise<UserRiskState>
  getAllFrozen(): Promise<UserRiskState[]>
  getHistory(userId: string): Promise<UserRiskStateEvent[]>
}
