import { z } from 'zod'

/** Body for POST /deals/:dealId/lease/sign (#1960). */
export const signatureRequestSchema = z.object({
  signerName: z
    .string()
    .trim()
    .min(1, 'signerName is required')
    .max(200)
    .describe('Full name typed by the signer'),
  signDate: z
    .string()
    .min(1, 'signDate is required')
    .describe('Signature date supplied by the client (yyyy-MM-dd)'),
  acknowledged: z
    .boolean()
    .refine((v) => v === true, { message: 'Lease terms must be acknowledged before signing' })
    .describe('The signer acknowledged the lease terms'),
})

export type SignatureRequest = z.infer<typeof signatureRequestSchema>

export const dealIdParamSchema = z.object({
  dealId: z.string().min(1).describe('Deal identifier'),
})

export type DealIdParam = z.infer<typeof dealIdParamSchema>
