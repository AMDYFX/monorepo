/**
 * Centralized API client for backend communication.
 *
 * All fetch logic flows through this module so that auth headers, error
 * handling, and base URL resolution happen in exactly one place.
 *
 * Features:
 * - Automatic retry with exponential backoff for transient failures
 * - Idempotency-Key per logical mutation, reused across retries
 * - User-friendly error messages
 * - Request correlation IDs
 */

import { apiFetch } from "./api";
import { retryWithBackoff, type RetryOptions } from "./retryLogic";
import { newIdempotencyKey } from "./idempotencyKey";

export { ApiError, isAccountFrozenError, ACCOUNT_FROZEN_MESSAGE } from "./api";

// Default retry options for API calls
const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  onRetry: (attempt, error) => {
    console.warn(
      `API call failed, retrying (attempt ${attempt}):`,
      error.message,
    );
  },
};

// ── HTTP helpers with retry logic ────────────────────────────────────────────

/**
 * Builds the init for a state-changing request. The Idempotency-Key is passed
 * in, not generated here, so the caller can create it once and reuse it for
 * every retry of the same operation.
 */
function mutatingRequest(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  idempotencyKey: string,
  body?: unknown,
): RequestInit {
  return {
    method,
    headers: { "Idempotency-Key": idempotencyKey },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export async function apiGet<T>(
  path: string,
  retryOptions?: RetryOptions,
): Promise<T> {
  return retryWithBackoff(() => apiFetch<T>(path, { method: "GET" }), {
    ...DEFAULT_RETRY_OPTIONS,
    ...retryOptions,
  });
}

/**
 * @param idempotencyKey Optional caller-owned key. Omit it to get a fresh key
 * for this call. Either way, every retry of this call sends the same key.
 */
export async function apiPost<T>(
  path: string,
  body: unknown,
  retryOptions?: RetryOptions,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<T> {
  return retryWithBackoff(
    () => apiFetch<T>(path, mutatingRequest("POST", idempotencyKey, body)),
    { ...DEFAULT_RETRY_OPTIONS, ...retryOptions },
  );
}

export async function apiPut<T>(
  path: string,
  body: unknown,
  retryOptions?: RetryOptions,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<T> {
  return retryWithBackoff(
    () => apiFetch<T>(path, mutatingRequest("PUT", idempotencyKey, body)),
    { ...DEFAULT_RETRY_OPTIONS, ...retryOptions },
  );
}

export async function apiPatch<T>(
  path: string,
  body: unknown,
  retryOptions?: RetryOptions,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<T> {
  return retryWithBackoff(
    () => apiFetch<T>(path, mutatingRequest("PATCH", idempotencyKey, body)),
    { ...DEFAULT_RETRY_OPTIONS, ...retryOptions },
  );
}

export async function apiDelete<T>(
  path: string,
  retryOptions?: RetryOptions,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<T> {
  return retryWithBackoff(
    () => apiFetch<T>(path, mutatingRequest("DELETE", idempotencyKey)),
    { ...DEFAULT_RETRY_OPTIONS, ...retryOptions },
  );
}

// ── Query string helper ──────────────────────────────────────────────────────

/**
 * Build a URL path with query parameters, omitting undefined/null values.
 *
 * @example
 * withQuery("/api/items", { status: "pending", limit: 10 })
 * // => "/api/items?status=pending&limit=10"
 */
export function withQuery(
  path: string,
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null) {
      qs.append(key, String(value));
    }
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}
