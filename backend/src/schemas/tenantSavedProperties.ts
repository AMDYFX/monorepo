import { z } from 'zod'

export const savedPropertyParamsSchema = z.object({
  listingId: z.string().uuid('listingId must be a valid listing id'),
})
