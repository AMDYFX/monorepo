/**
 * Tenant payment actions (quick pay, top-up) use the shared `offline-queue` in `api.ts`
 * when the browser is offline. Send a stable `x-idempotency-key` (UUID) on POSTs
 * so the backend durable idempotency layer can merge retries safely.
 */
import {
  flushOfflineQueue,
  enqueueOfflineRequest,
} from "./offline-queue";
import { newIdempotencyKey } from "./idempotencyKey";

const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

export { flushOfflineQueue, enqueueOfflineRequest, newIdempotencyKey };

export async function flushPaymentQueue() {
  return flushOfflineQueue(baseUrl);
}

/** Fingerprint to detect duplicate queued payment intents in the UI. */
export function paymentActionFingerprint(
  op: "tenant-quick-pay" | "tenant-topup" | "ngn-topup",
  body: unknown,
) {
  return `${op}:${JSON.stringify(body)}`;
}
