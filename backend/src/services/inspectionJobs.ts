/**
 * Pure rules for the inspection job board (#1903).
 */

export const DEFAULT_CLAIM_WINDOW_HOURS = 48

/** Hours an inspector has to submit a report after claiming a job. INSPECTION_CLAIM_WINDOW_HOURS overrides it. */
export function getClaimWindowMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.INSPECTION_CLAIM_WINDOW_HOURS)
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLAIM_WINDOW_HOURS
  return hours * 60 * 60 * 1000
}

export function claimDeadlineFrom(now: Date, windowMs: number): Date {
  return new Date(now.getTime() + windowMs)
}

/** A claim is live until its deadline. Expired claims are released by the expiry job. */
export function isClaimLive(claimDeadline: Date | null, now: Date): boolean {
  return claimDeadline !== null && claimDeadline.getTime() > now.getTime()
}

/** Case-insensitive match of a listing's area against the inspector's service areas. */
export function isInServiceArea(area: string | null | undefined, serviceAreas: string[]): boolean {
  if (!area) return false
  const normalized = area.trim().toLowerCase()
  return serviceAreas.some((serviceArea) => serviceArea.trim().toLowerCase() === normalized)
}

/** Object keys issued by the presign endpoint for one job all share this prefix. */
export function reportPhotoKeyPrefix(jobId: string): string {
  return `inspection-reports/${jobId}/`
}

/** Stops a report from attaching another job's photos, or arbitrary storage keys. */
export function photoKeysBelongToJob(jobId: string, photoKeys: string[]): boolean {
  const prefix = reportPhotoKeyPrefix(jobId)
  return photoKeys.every((key) => key.startsWith(prefix) && !key.includes('..'))
}
