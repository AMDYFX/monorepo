import type { BackendErrorResponse } from "./errors";
import { enqueueOfflineRequest } from "./offline-queue";
import { newIdempotencyKey } from "./idempotencyKey";
import { apiRateLimiters } from "./rate-limiter";

const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";
const apiVersion = "/api/v1";

/**
 * Normalize API paths to remove duplicate /api and /api/v1 prefixes.
 * Accepts /foo, /api/foo, or /api/v1/foo and returns /foo.
 * Absolute URLs are passed through unchanged.
 * Query strings and trailing slashes are preserved.
 */
function normalizePath(path: string): string {
  // Pass through absolute URLs
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  // Extract query string and fragment
  const hashIndex = path.indexOf("#");
  const queryIndex = path.indexOf("?");
  let basePath = path;
  let query = "";

  if (queryIndex !== -1) {
    basePath = path.substring(0, queryIndex);
    query = path.substring(queryIndex);
  } else if (hashIndex !== -1) {
    basePath = path.substring(0, hashIndex);
    query = path.substring(hashIndex);
  }

  // Remove /api/v1 prefix
  if (basePath.startsWith("/api/v1/")) {
    basePath = basePath.substring(8); // Remove "/api/v1/"
  } else if (basePath === "/api/v1") {
    basePath = "";
  }
  // Remove /api prefix
  else if (basePath.startsWith("/api/")) {
    basePath = basePath.substring(5); // Remove "/api/"
  } else if (basePath === "/api") {
    basePath = "";
  }

  // Ensure path starts with /
  if (basePath && !basePath.startsWith("/")) {
    basePath = "/" + basePath;
  }

  return basePath + query;
}

export const ACCOUNT_FROZEN_MESSAGE =
  "Account frozen due to negative balance. Please top up to continue.";

export class ApiError extends Error {
  code?: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(params: {
    message: string;
    status: number;
    code?: string;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = "ApiError";
    this.status = params.status;
    this.code = params.code;
    this.details = params.details;
  }
}

export function isAccountFrozenError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "ACCOUNT_FROZEN";
}

function parseErrorPayload(payload: unknown): {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
} {
  if (!payload || typeof payload !== "object") {
    return { message: "" };
  }

  const maybeError = (payload as { error?: unknown }).error;
  if (!maybeError || typeof maybeError !== "object") {
    return { message: "" };
  }

  const typedError = maybeError as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };

  const code =
    typeof typedError.code === "string" ? typedError.code : undefined;
  let baseMessage = "";
  if (code === "ACCOUNT_FROZEN") {
    baseMessage = ACCOUNT_FROZEN_MESSAGE;
  } else if (typeof typedError.message === "string") {
    baseMessage = typedError.message;
  }

  const details =
    typedError.details && typeof typedError.details === "object"
      ? (typedError.details as Record<string, unknown>)
      : undefined;

  return { message: baseMessage, code, details };
}

function isBrowser(): boolean {
  return globalThis.window !== undefined;
}

function getAuthToken(): string | null {
  return isBrowser() ? localStorage.getItem("shelterflex_token") : null;
}

function isStateMutatingMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method);
}

function getRateLimiterForRequest(path: string, options?: RequestInit) {
  const normalizedPath = normalizePath(path);
  if (
    normalizedPath.includes("/auth") ||
    normalizedPath.includes("/login") ||
    normalizedPath.includes("/register") ||
    normalizedPath.includes("/forgot-password")
  ) {
    return apiRateLimiters.auth;
  }
  if (options?.body instanceof FormData || normalizedPath.includes("/upload")) {
    return apiRateLimiters.upload;
  }
  const method = (options?.method ?? "GET").toUpperCase();
  if (
    isStateMutatingMethod(method) &&
    (normalizedPath.includes("/stake") ||
      normalizedPath.includes("/claim") ||
      normalizedPath.includes("/pay") ||
      normalizedPath.includes("/transfer") ||
      normalizedPath.includes("/withdraw"))
  ) {
    return apiRateLimiters.sensitive;
  }
  return apiRateLimiters.general;
}

async function attachCsrfHeaderIfNeeded(
  headers: Headers,
  method: string,
): Promise<void> {
  if (!isBrowser() || !isStateMutatingMethod(method)) {
    return;
  }

  const { csrfProtection } = await import("./csrf-protection");
  const csrfToken =
    csrfProtection.getCurrentToken() ?? csrfProtection.initialize();
  headers.set("X-CSRF-Token", csrfToken);
}

function shouldQueueOfflineRequest(method: string): boolean {
  return isBrowser() && !navigator.onLine && isStateMutatingMethod(method);
}

async function parseBackendErrorResponse(
  res: Response,
): Promise<BackendErrorResponse | null> {
  try {
    const text = await res.text();
    if (!text) {
      return null;
    }
    return JSON.parse(text) as BackendErrorResponse;
  } catch {
    return null;
  }
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  if (!baseUrl) {
    throw new Error("Missing NEXT_PUBLIC_BACKEND_URL");
  }

  // Normalize path to remove duplicate /api prefixes
  const normalizedPath = normalizePath(path);
  const method = (options?.method ?? "GET").toUpperCase();

  if (isBrowser()) {
    const limiter = getRateLimiterForRequest(normalizedPath, options);
    const identifier = `${method}:${normalizedPath}`;
    const check = limiter.checkLimit(identifier);
    if (!check.allowed) {
      throw new ApiError({
        message: "Rate limit exceeded. Please try again later.",
        status: 429,
        code: "RATE_LIMIT_EXCEEDED",
        details: {
          remaining: check.remaining,
          resetTime: check.resetTime,
        },
      });
    }
  }

  const token = getAuthToken();

  const headers = new Headers(options?.headers);
  if (!(options?.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  await attachCsrfHeaderIfNeeded(headers, method);

  if (isStateMutatingMethod(method)) {
    const hasIdempotencyKey =
      headers.has("Idempotency-Key") || headers.has("idempotency-key");
    if (!hasIdempotencyKey) {
      headers.set("Idempotency-Key", newIdempotencyKey());
    }
  }

  try {
    if (shouldQueueOfflineRequest(method)) {
      enqueueOfflineRequest({
        path: normalizedPath,
        method: method as "POST" | "PUT" | "PATCH" | "DELETE",
        body: typeof options?.body === "string" ? options.body : null,
        headers: Object.fromEntries(headers.entries()),
      });

      return {
        queued: true,
        offline: true,
      } as T;
    }

    // Build the full URL: if normalized path is absolute, use it directly
    const fullUrl =
      normalizedPath.startsWith("http://") ||
      normalizedPath.startsWith("https://")
        ? normalizedPath
        : `${baseUrl}${apiVersion}${normalizedPath}`;

    const res = await fetch(fullUrl, {
      cache: "no-store",
      ...options,
      // Merged headers go last. A spread after them would replace the auth,
      // CSRF and Idempotency-Key headers whenever the caller passed `headers`.
      headers,
    });

    if (!res.ok) {
      const errorResponse = await parseBackendErrorResponse(res);
      const { message, code, details } = parseErrorPayload(errorResponse);
      throw new ApiError({
        message: message || `API error: ${res.status}`,
        status: res.status,
        code,
        details,
      });
    }

    if (res.status === 204 || res.status === 205) {
      return null as unknown as T;
    }

    return res.json();
  } catch (error) {
    // Re-throw ApiError as-is
    if (error instanceof ApiError) {
      throw error;
    }

    // Handle network errors
    if (error instanceof TypeError && error.message === "Failed to fetch") {
      throw new Error(
        `Cannot connect to backend at ${baseUrl}. Please ensure the backend server is running.`,
      );
    }
    throw error;
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
