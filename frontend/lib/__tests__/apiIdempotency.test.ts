import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch } from '../api';

describe('apiFetch Idempotency-Key handling', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    }));
  });

  it('automatically attaches an Idempotency-Key header on POST requests', async () => {
    await apiFetch('/test-endpoint', {
      method: 'POST',
      body: JSON.stringify({ foo: 'bar' }),
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    const headers = options.headers as Headers;
    const idemKey = headers.get('Idempotency-Key');
    expect(idemKey).toBeDefined();
    expect(typeof idemKey).toBe('string');
    expect(idemKey!.length).toBeGreaterThan(0);
  });

  it('does not overwrite a caller-supplied Idempotency-Key header', async () => {
    const customKey = 'custom-uuid-1234-5678';
    await apiFetch('/test-endpoint', {
      method: 'POST',
      headers: {
        'Idempotency-Key': customKey,
      },
      body: JSON.stringify({ foo: 'bar' }),
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const [, options] = fetchMock.mock.calls[0];
    const headers = options.headers as Headers;
    expect(headers.get('Idempotency-Key')).toBe(customKey);
  });

  it('keeps the Idempotency-Key when the caller also passes other headers', async () => {
    await apiFetch('/test-endpoint', {
      method: 'POST',
      headers: { 'X-Request-Source': 'test' },
      body: JSON.stringify({ foo: 'bar' }),
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const [, options] = fetchMock.mock.calls[0];
    const headers = options.headers as Headers;
    expect(headers.get('X-Request-Source')).toBe('test');
    expect(headers.get('Idempotency-Key')).toBeTruthy();
  });

  it('does not attach an Idempotency-Key header on GET requests', async () => {
    await apiFetch('/test-endpoint', {
      method: 'GET',
    });

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const [, options] = fetchMock.mock.calls[0];
    const headers = options.headers as Headers;
    expect(headers.has('Idempotency-Key')).toBe(false);
  });
});
