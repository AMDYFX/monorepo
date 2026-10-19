/**
 * Releases inspection job claims whose deadline has passed back to `available` (#1903).
 */

import { inspectionJobStore } from '../models/inspectionJobStore.js'
import { logger } from '../utils/logger.js'

export const INSPECTION_CLAIM_EXPIRY_INTERVAL_MS = 5 * 60 * 1000

export async function releaseExpiredInspectionClaims(now: Date = new Date()): Promise<number> {
  const released = await inspectionJobStore.releaseExpiredClaims(now)
  if (released > 0) {
    logger.info('inspection.claims_expired', { released })
  }
  return released
}

/** Starts the periodic release. Returns the timer so the caller can clear it on shutdown. */
export function startInspectionClaimExpiryJob(
  intervalMs: number = INSPECTION_CLAIM_EXPIRY_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    releaseExpiredInspectionClaims().catch((error: unknown) => {
      logger.error('inspection.claim_expiry_failed', { error: String(error) })
    })
  }, intervalMs)
}
