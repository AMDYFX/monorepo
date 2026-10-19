import { z } from 'zod'

/**
 * Schemas for the tenant rating card (#1905).
 */

export const dealIdParamSchema = z.object({
  dealId: z.string().uuid('Deal ID must be a UUID'),
})

const score = z.number().int().min(1).max(5)

/** Landlord rating of a tenant for one deal. `overall` is derived server-side. */
export const createTenantRatingSchema = z.object({
  paymentTimeliness: score,
  propertyCare: score,
  communication: score,
  comment: z.string().trim().max(500).optional(),
})

export type CreateTenantRatingRequest = z.infer<typeof createTenantRatingSchema>

export const SHARE_TOKEN_MAX_TTL_DAYS = 30
export const SHARE_TOKEN_DEFAULT_TTL_DAYS = 7

// A missing body is allowed and means the default TTL.
export const createRatingCardShareSchema = z
  .object({
    ttlDays: z
      .number()
      .int()
      .min(1)
      .max(SHARE_TOKEN_MAX_TTL_DAYS)
      .default(SHARE_TOKEN_DEFAULT_TTL_DAYS),
  })
  .default({})

export type CreateRatingCardShareRequest = z.infer<typeof createRatingCardShareSchema>

export const shareIdParamSchema = z.object({
  id: z.string().uuid('Share ID must be a UUID'),
})

/** Public share tokens are 128-bit values rendered as 32 lowercase hex characters. */
export const publicRatingCardTokenParamSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{32}$/, 'Invalid rating card token'),
})
