import { z } from 'zod'

/** Query params for GET /landlord/analytics (#1958). */
export const landlordAnalyticsQuerySchema = z.object({
  propertyId: z.string().trim().min(1).max(128).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
})

export type LandlordAnalyticsQuery = z.infer<typeof landlordAnalyticsQuerySchema>

/** Maximum window the analytics endpoint will compute, in months. */
export const MAX_ANALYTICS_MONTHS = 24
