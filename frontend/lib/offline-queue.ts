import { newIdempotencyKey } from './idempotencyKey'

export type OfflineQueueMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface OfflineQueueEntry {
  id: string
  path: string
  method: OfflineQueueMethod
  body: string | null
  headers: Record<string, string>
  createdAt: string
  retryCount: number
}

export interface OfflineQueueFailure extends OfflineQueueEntry {
  failedAt: string
  reason: string
}

export type FlushStatus = 'idle' | 'replaying' | 'completed' | 'partial' | 'failed'

export interface FlushProgress {
  status: FlushStatus
  processed: number
  total: number
  failedCount: number
}

export const OFFLINE_QUEUE_STORAGE_KEY = 'shelterflex-offline-queue'
export const OFFLINE_QUEUE_FAILURE_STORAGE_KEY = 'shelterflex-offline-queue-failures'

const MAX_RETRIES_PER_ITEM = 3
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 10_000

function getStorage() {
  if (typeof window === 'undefined') {
    return null
  }
  return window.localStorage
}

function readEntries<T>(storageKey: string): T[] {
  const storage = getStorage()
  if (!storage) {
    return []
  }

  const raw = storage.getItem(storageKey)
  if (!raw) {
    return []
  }

  try {
    return JSON.parse(raw) as T[]
  } catch {
    storage.removeItem(storageKey)
    return []
  }
}

function readQueue(): OfflineQueueEntry[] {
  return readEntries<OfflineQueueEntry>(OFFLINE_QUEUE_STORAGE_KEY)
}

function readFailures(): OfflineQueueFailure[] {
  return readEntries<OfflineQueueFailure>(OFFLINE_QUEUE_FAILURE_STORAGE_KEY)
}

function writeEntries<T>(
  storageKey: string,
  eventName: string,
  entries: T[],
  detail: Record<string, number>,
) {
  const storage = getStorage()
  if (!storage) {
    return
  }

  storage.setItem(storageKey, JSON.stringify(entries))
  window.dispatchEvent(
    new CustomEvent(eventName, {
      detail,
    }),
  )
}

function writeQueue(entries: OfflineQueueEntry[]) {
  writeEntries(OFFLINE_QUEUE_STORAGE_KEY, 'offline-queue-updated', entries, {
    count: entries.length,
  })
}

function writeFailures(entries: OfflineQueueFailure[]) {
  writeEntries(
    OFFLINE_QUEUE_FAILURE_STORAGE_KEY,
    'offline-queue-failures-updated',
    entries,
    { count: entries.length },
  )
}

function isNonRetryable(status: number): boolean {
  if (status >= 400 && status < 500) {
    return status !== 409 && status !== 429
  }
  return false
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function emitFlushEvent(progress: FlushProgress) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('offline-flush-progress', { detail: progress }),
  )
}

export function getOfflineQueueCount() {
  return readQueue().length
}

export function getOfflineQueueFailures() {
  return readFailures()
}

export function enqueueOfflineRequest(
  entry: Omit<OfflineQueueEntry, 'id' | 'createdAt' | 'retryCount'>,
) {
  // Keep one key per queued action. Headers from apiFetch arrive lowercased,
  // so drop any casing of the key before writing it back, or replay would send
  // the header twice.
  const headers: Record<string, string> = {}
  let existingIdempotencyKey: string | undefined
  for (const [name, value] of Object.entries(entry.headers)) {
    if (name.toLowerCase() === 'idempotency-key') {
      existingIdempotencyKey = value
    } else {
      headers[name] = value
    }
  }
  const idempotencyKey = existingIdempotencyKey ?? newIdempotencyKey()

  const entries = readQueue()
  entries.push({
    ...entry,
    id: `offline_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    headers: {
      ...headers,
      'Idempotency-Key': idempotencyKey,
    },
    createdAt: new Date().toISOString(),
    retryCount: 0,
  })
  writeQueue(entries)
}

export function clearOfflineQueue() {
  writeQueue([])
}

export function clearOfflineQueueFailures() {
  writeFailures([])
}

export type ReconciliationCallback = (processed: number) => Promise<void>

function recordFailure(entry: OfflineQueueEntry, reason: string) {
  const failures = readFailures()
  failures.push({
    ...entry,
    failedAt: new Date().toISOString(),
    reason,
  })
  writeFailures(failures)
}

export async function flushOfflineQueue(
  baseUrl: string,
  onReconcile?: ReconciliationCallback,
): Promise<number> {
  const entries = readQueue()
  if (!entries.length) {
    emitFlushEvent({ status: 'completed', processed: 0, total: 0, failedCount: 0 })
    return 0
  }

  emitFlushEvent({
    status: 'replaying',
    processed: 0,
    total: entries.length,
    failedCount: 0,
  })

  const remaining: OfflineQueueEntry[] = []
  let processed = 0
  let failedCount = 0

  for (const entry of entries) {
    if (entry.retryCount >= MAX_RETRIES_PER_ITEM) {
      recordFailure(
        entry,
        `Stopped retrying after ${MAX_RETRIES_PER_ITEM} attempts.`,
      )
      failedCount += 1
      continue
    }

    try {
      const response = await fetch(`${baseUrl}${entry.path}`, {
        method: entry.method,
        headers: entry.headers,
        body: entry.body,
      })

      if (isNonRetryable(response.status)) {
        recordFailure(
          entry,
          `Replay rejected with ${response.status}. The action is no longer valid.`,
        )
        failedCount += 1
        continue
      }

      if (!response.ok) {
        entry.retryCount += 1
        failedCount += 1

        if (entry.retryCount >= MAX_RETRIES_PER_ITEM) {
          recordFailure(
            entry,
            `Stopped retrying after ${MAX_RETRIES_PER_ITEM} attempts.`,
          )
        } else {
          remaining.push(entry)
        }

        const delay = Math.min(
          BASE_BACKOFF_MS * Math.pow(2, entry.retryCount - 1) +
            Math.random() * BASE_BACKOFF_MS,
          MAX_BACKOFF_MS,
        )
        emitFlushEvent({
          status: 'replaying',
          processed,
          total: entries.length,
          failedCount,
        })
        await sleep(delay)
        continue
      }

      processed += 1
      emitFlushEvent({
        status: 'replaying',
        processed,
        total: entries.length,
        failedCount,
      })
    } catch {
      entry.retryCount += 1
      failedCount += 1

      if (entry.retryCount >= MAX_RETRIES_PER_ITEM) {
        recordFailure(
          entry,
          `Stopped retrying after ${MAX_RETRIES_PER_ITEM} attempts due to repeated network errors.`,
        )
      } else {
        remaining.push(entry)
      }

      const delay = Math.min(
        BASE_BACKOFF_MS * Math.pow(2, entry.retryCount - 1) +
          Math.random() * BASE_BACKOFF_MS,
        MAX_BACKOFF_MS,
      )
      emitFlushEvent({
        status: 'replaying',
        processed,
        total: entries.length,
        failedCount,
      })
      await sleep(delay)
    }
  }

  writeQueue(remaining)

  const status: FlushStatus =
    processed === 0 ? 'failed' : failedCount > 0 ? 'partial' : 'completed'

  emitFlushEvent({
    status,
    processed,
    total: entries.length,
    failedCount,
  })

  if (processed > 0 && onReconcile) {
    await onReconcile(processed)
  }

  return processed
}
