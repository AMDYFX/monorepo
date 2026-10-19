import { describe, expect, it, vi } from 'vitest'
import {
  clearOfflineQueue,
  clearOfflineQueueFailures,
  enqueueOfflineRequest,
  flushOfflineQueue,
  getOfflineQueueCount,
  getOfflineQueueFailures,
} from '@/lib/offline-queue'

describe('offline queue', () => {
  it('survives a reload because entries are persisted in localStorage', async () => {
    enqueueOfflineRequest({
      path: '/api/items',
      method: 'POST',
      body: '{"value":1}',
      headers: { 'Content-Type': 'application/json' },
    })

    expect(getOfflineQueueCount()).toBe(1)

    vi.resetModules()
    const reloadedModule = await import('@/lib/offline-queue')
    expect(reloadedModule.getOfflineQueueCount()).toBe(1)

    reloadedModule.clearOfflineQueue()
  })

  it('stores offline mutations locally', () => {
    enqueueOfflineRequest({
      path: '/api/items',
      method: 'POST',
      body: '{"value":1}',
      headers: { 'Content-Type': 'application/json' },
    })

    expect(getOfflineQueueCount()).toBe(1)
  })

  it('flushes successful requests and clears the queue', async () => {
    enqueueOfflineRequest({
      path: '/api/items',
      method: 'POST',
      body: '{"value":1}',
      headers: { 'Content-Type': 'application/json' },
    })
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const flushed = await flushOfflineQueue('https://api.example.com')

    expect(flushed).toBe(1)
    expect(getOfflineQueueCount()).toBe(0)
    clearOfflineQueue()
  })

  it('replays a queued request with the same idempotency key', async () => {
    enqueueOfflineRequest({
      path: '/api/items',
      method: 'POST',
      body: '{"value":1}',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'payment-intent-123',
      },
    })

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    await flushOfflineQueue('https://api.example.com')

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/api/items',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Idempotency-Key': 'payment-intent-123',
        }),
      }),
    )
    clearOfflineQueue()
  })

  it('stores exactly one Idempotency-Key when apiFetch passes a lowercase header', () => {
    enqueueOfflineRequest({
      path: '/api/items',
      method: 'POST',
      body: '{"value":1}',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'lowercase-key-1',
      },
    })

    const [stored] = JSON.parse(localStorage.getItem('shelterflex-offline-queue') ?? '[]')
    const keyNames = Object.keys(stored.headers).filter(
      (name) => name.toLowerCase() === 'idempotency-key',
    )
    expect(keyNames).toEqual(['Idempotency-Key'])
    expect(stored.headers['Idempotency-Key']).toBe('lowercase-key-1')
    clearOfflineQueue()
  })

  it('generates a UUID key for queued requests that have none', () => {
    enqueueOfflineRequest({
      path: '/api/items',
      method: 'POST',
      body: '{"value":1}',
      headers: { 'Content-Type': 'application/json' },
    })

    const [stored] = JSON.parse(localStorage.getItem('shelterflex-offline-queue') ?? '[]')
    expect(stored.headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    clearOfflineQueue()
  })

  it('moves invalidated actions into the surfaced failure list', async () => {
    enqueueOfflineRequest({
      path: '/api/items',
      method: 'POST',
      body: '{"value":1}',
      headers: { 'Content-Type': 'application/json' },
    })

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), { status: 410 }),
    )

    await flushOfflineQueue('https://api.example.com')

    expect(getOfflineQueueCount()).toBe(0)
    expect(getOfflineQueueFailures()).toHaveLength(1)

    clearOfflineQueue()
    clearOfflineQueueFailures()
  })
})
