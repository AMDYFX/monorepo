import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/retryLogic', () => ({
  retryWithBackoff: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
}))

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    code?: string
    constructor({ message, status, code }: { message: string; status: number; code?: string }) {
      super(message)
      this.status = status
      this.code = code
    }
  },
  isAccountFrozenError: vi.fn(),
  ACCOUNT_FROZEN_MESSAGE: 'Account frozen',
}))

import { apiGet, apiPost, apiPut, apiPatch, apiDelete, withQuery } from '@/lib/apiClient'
import { apiFetch } from '@/lib/api'
import { retryWithBackoff } from '@/lib/retryLogic'

const mockedApiFetch = vi.mocked(apiFetch)
const mockedRetry = vi.mocked(retryWithBackoff)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('apiClient helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockedApiFetch.mockReset()
    mockedRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn())
  })

  describe('apiGet', () => {
    it('calls retryWithBackoff wrapping apiFetch with GET', async () => {
      mockedApiFetch.mockResolvedValue({ id: 1 })

      const result = await apiGet('/api/items/1')

      expect(mockedRetry).toHaveBeenCalled()
      expect(result).toEqual({ id: 1 })
    })
  })

  describe('apiPost', () => {
    it('wraps apiFetch with POST, body and a generated Idempotency-Key', async () => {
      mockedApiFetch.mockResolvedValue({ created: true })

      await apiPost('/api/items', { name: 'test' })

      expect(mockedRetry).toHaveBeenCalled()
      expect(mockedApiFetch).toHaveBeenCalledWith('/api/items', {
        method: 'POST',
        headers: { 'Idempotency-Key': expect.stringMatching(UUID_PATTERN) },
        body: JSON.stringify({ name: 'test' }),
      })
    })

    it('sends the same Idempotency-Key on every retry of one operation', async () => {
      mockedApiFetch.mockResolvedValue({ ok: true })
      // Simulate three attempts of the same logical operation
      mockedRetry.mockImplementation(async (fn: () => Promise<unknown>) => {
        await fn()
        await fn()
        return fn()
      })

      await apiPost('/api/payments', { amount: 5000 })

      const keys = mockedApiFetch.mock.calls.map(
        ([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key'],
      )
      expect(keys).toHaveLength(3)
      expect(new Set(keys).size).toBe(1)
    })

    it('uses a different Idempotency-Key for two separate calls', async () => {
      mockedApiFetch.mockResolvedValue({ ok: true })

      await apiPost('/api/payments', { amount: 5000 })
      await apiPost('/api/payments', { amount: 5000 })

      const [first, second] = mockedApiFetch.mock.calls.map(
        ([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key'],
      )
      expect(first).not.toBe(second)
    })

    it('uses a caller-supplied Idempotency-Key and reuses it across retries', async () => {
      mockedApiFetch.mockResolvedValue({ ok: true })
      mockedRetry.mockImplementation(async (fn: () => Promise<unknown>) => {
        await fn()
        return fn()
      })

      await apiPost('/api/payments', { amount: 5000 }, undefined, 'intent-abc-123')

      for (const [, init] of mockedApiFetch.mock.calls) {
        expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe('intent-abc-123')
      }
    })
  })

  describe('apiPut', () => {
    it('wraps apiFetch with PUT, body and an Idempotency-Key', async () => {
      mockedApiFetch.mockResolvedValue({ updated: true })

      await apiPut('/api/items/1', { name: 'updated' })

      expect(mockedApiFetch).toHaveBeenCalledWith('/api/items/1', {
        method: 'PUT',
        headers: { 'Idempotency-Key': expect.stringMatching(UUID_PATTERN) },
        body: JSON.stringify({ name: 'updated' }),
      })
    })
  })

  describe('apiPatch', () => {
    it('wraps apiFetch with PATCH, body and an Idempotency-Key', async () => {
      mockedApiFetch.mockResolvedValue({ patched: true })

      await apiPatch('/api/items/1', { name: 'patched' })

      expect(mockedApiFetch).toHaveBeenCalledWith('/api/items/1', {
        method: 'PATCH',
        headers: { 'Idempotency-Key': expect.stringMatching(UUID_PATTERN) },
        body: JSON.stringify({ name: 'patched' }),
      })
    })
  })

  describe('apiDelete', () => {
    it('wraps apiFetch with DELETE and an Idempotency-Key', async () => {
      mockedApiFetch.mockResolvedValue({ deleted: true })

      await apiDelete('/api/items/1')

      expect(mockedApiFetch).toHaveBeenCalledWith('/api/items/1', {
        method: 'DELETE',
        headers: { 'Idempotency-Key': expect.stringMatching(UUID_PATTERN) },
      })
    })
  })

  describe('withQuery', () => {
    it('appends query parameters', () => {
      const result = withQuery('/api/items', { status: 'active', limit: 10 })
      expect(result).toBe('/api/items?status=active&limit=10')
    })

    it('omits null and undefined values', () => {
      const result = withQuery('/api/items', { status: 'active', page: undefined, limit: null })
      expect(result).toBe('/api/items?status=active')
    })

    it('returns path without query string when no params', () => {
      const result = withQuery('/api/items', {})
      expect(result).toBe('/api/items')
    })

    it('handles boolean values', () => {
      const result = withQuery('/api/items', { active: true })
      expect(result).toBe('/api/items?active=true')
    })
  })
})
