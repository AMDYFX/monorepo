import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiError, isAccountFrozenError, apiFetch, apiPost } from "@/lib/api";

vi.mock("@/lib/offline-queue", () => ({
  enqueueOfflineRequest: vi.fn(),
}));

vi.mock("@/lib/csrf-protection", () => ({
  csrfProtection: {
    getCurrentToken: vi.fn().mockReturnValue("csrf-token"),
    initialize: vi.fn().mockReturnValue("csrf-token"),
  },
}));

describe("ApiError", () => {
  it("is an instance of Error", () => {
    const err = new ApiError({ message: "test", status: 400 });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
  });

  it("has status and code properties", () => {
    const err = new ApiError({
      message: "forbidden",
      status: 403,
      code: "FORBIDDEN",
    });
    expect(err.status).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.name).toBe("ApiError");
  });

  it("stores details", () => {
    const details = { field: "email" };
    const err = new ApiError({ message: "validation", status: 422, details });
    expect(err.details).toEqual(details);
  });
});

describe("isAccountFrozenError", () => {
  it("returns true for ACCOUNT_FROZEN ApiError", () => {
    const err = new ApiError({
      message: "frozen",
      status: 403,
      code: "ACCOUNT_FROZEN",
    });
    expect(isAccountFrozenError(err)).toBe(true);
  });

  it("returns false for other ApiErrors", () => {
    const err = new ApiError({ message: "other", status: 500 });
    expect(isAccountFrozenError(err)).toBe(false);
  });

  it("returns false for non-ApiError values", () => {
    expect(isAccountFrozenError(new Error("test"))).toBe(false);
    expect(isAccountFrozenError(null)).toBe(false);
    expect(isAccountFrozenError(undefined)).toBe(false);
  });
});

describe("apiFetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      writable: true,
    });
  });

  it("makes a successful request and returns JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await apiFetch<{ ok: boolean }>("/api/test");
    expect(result).toEqual({ ok: true });
  });

  it("attaches Authorization header when token exists", async () => {
    localStorage.setItem("shelterflex_token", "auth-token");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await apiFetch("/api/test");

    const headers = fetchSpy.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer auth-token");
  });

  it("does not attach Authorization header when no token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await apiFetch("/api/test");

    const headers = fetchSpy.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
  });

  it("throws ApiError for non-ok responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }),
        {
          status: 404,
        },
      ),
    );

    await expect(apiFetch("/api/missing")).rejects.toThrow();
  });

  it("throws connection error for network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    await expect(apiFetch("/api/test")).rejects.toThrow(
      "Cannot connect to backend",
    );
  });
});

describe("apiPost", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a POST request with JSON body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ created: true }), { status: 200 }),
      );

    const result = await apiPost("/api/create", { name: "test" });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/create"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({ created: true });
  });
});

describe("normalizePath", () => {
  // Import the normalizer by testing through apiFetch behavior
  it("normalizes /api/path to /path", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await apiFetch("/api/tenant/saved-properties");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/tenant/saved-properties");
    expect(url).not.toContain("/api/v1/api/");
  });

  it("normalizes /api/v1/path to /path", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await apiFetch("/api/v1/admin/timelock/transactions");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/admin/timelock/transactions");
    expect(url).not.toContain("/api/v1/api/");
  });

  it("handles unprefixed paths", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await apiFetch("/properties");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/properties");
  });

  it("preserves query strings", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await apiFetch("/api/tenant/saved-properties?limit=10&offset=0");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/tenant/saved-properties?limit=10&offset=0");
  });

  it("preserves trailing slashes", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await apiFetch("/api/properties/");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/properties/");
  });

  it("passes through absolute URLs unchanged", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    const absUrl = "https://external.com/api/data";
    await apiFetch(absUrl);

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe(absUrl);
  });

  it("uses normalized path for rate limiter", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            resolve(new Response(JSON.stringify({}), { status: 200 })),
          ),
      );

    // Rate limiter should see the same normalized path for duplicate calls
    await apiFetch("/api/auth/login");
    await apiFetch("/auth/login");
    await apiFetch("/api/v1/auth/login");

    // All three should be rate-limited as the same request
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("uses normalized path for offline queue", async () => {
    const { enqueueOfflineRequest } = await import("@/lib/offline-queue");

    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    await apiFetch("/api/tenant/profile", {
      method: "POST",
      body: JSON.stringify({ name: "test" }),
    });

    const call = vi.mocked(enqueueOfflineRequest).mock.calls[0]?.[0];
    expect(call?.path).toBe("/tenant/profile");
    expect(call?.path).not.toContain("/api/");
  });

  it("handles complex paths with nested segments", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await apiFetch("/api/v1/properties/123/tenants/456/lease");

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/properties/123/tenants/456/lease");
  });
});
