import { z } from 'zod'
import { ListingStatus } from '../models/listing.js'

/**
 * Schema for creating a new listing
 */
export const createListingSchema = z.object({
  whistleblowerId: z.string().min(1, 'Whistleblower ID is required'),
  address: z.string().min(1, 'Address is required'),
  city: z.string().optional(),
  area: z.string().optional(),
  bedrooms: z.number().int().min(0, 'Bedrooms must be 0 or greater'),
  bathrooms: z.number().int().min(0, 'Bathrooms must be 0 or greater'),
  annualRentNgn: z
    .number()
    .positive('Annual rent must be greater than 0')
    .int('Annual rent must be a whole number'),
  outrightPriceNgn: z
    .number()
    .positive('Outright price must be greater than 0')
    .int('Outright price must be a whole number')
    .optional(),
  installmentBasePriceNgn: z
    .number()
    .positive('Installment base price must be greater than 0')
    .int('Installment base price must be a whole number')
    .optional(),
  negotiatedLandlordRateNgn: z
    .number()
    .positive('Negotiated landlord rate must be greater than 0')
    .int('Negotiated landlord rate must be a whole number')
    .optional(),
  description: z.string().optional(),
  photos: z
    .array(z.string().url('Each photo must be a valid URL'))
    .min(3, 'At least 3 photos are required')
    .max(20, 'Maximum 20 photos allowed'),
}).refine(
  (data) => {
    if (data.negotiatedLandlordRateNgn != null && data.outrightPriceNgn != null) {
      return data.negotiatedLandlordRateNgn < data.outrightPriceNgn
    }
    return true
  },
  {
    message: 'negotiatedLandlordRateNgn must be less than outrightPriceNgn',
    path: ['negotiatedLandlordRateNgn'],
  },
).refine(
  (data) => {
    if (data.outrightPriceNgn != null && data.installmentBasePriceNgn != null) {
      return data.outrightPriceNgn <= data.installmentBasePriceNgn
    }
    return true
  },
  {
    message: 'outrightPriceNgn must be less than or equal to installmentBasePriceNgn',
    path: ['outrightPriceNgn'],
  },
)

export type CreateListingRequest = z.infer<typeof createListingSchema>

/**
 * Schema for listing filters (query params)
 */
export const listingFiltersSchema = z.object({
  status: z.nativeEnum(ListingStatus).optional(),
  query: z.string().optional(),
  q: z.string().optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  bedrooms: z.coerce.number().int().min(0).optional(),
  lga: z.string().optional(),
  paymentPlan: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export type ListingFiltersRequest = z.infer<typeof listingFiltersSchema>

export const propertySearchSchema = listingFiltersSchema.omit({ status: true })
export type PropertySearchRequest = z.infer<typeof propertySearchSchema>

export const listingSuggestSchema = z.object({
  q: z.string().trim().min(1).max(100),
})

export type ListingSuggestRequest = z.infer<typeof listingSuggestSchema>

/**
 * Query params for GET /api/admin/whistleblower/listings
 * Defaults to pending_review so the moderation queue is immediately visible
 */
export const adminListingFiltersSchema = z.object({
  status: z.nativeEnum(ListingStatus).optional().default(ListingStatus.PENDING_REVIEW),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export type AdminListingFiltersRequest = z.infer<typeof adminListingFiltersSchema>

/**
 * Body for POST /api/admin/whistleblower/listings/:id/approve
 */
export const approveListingSchema = z.object({
  reviewedBy: z.string().min(1, 'Reviewer ID is required'),
})

export type ApproveListingRequest = z.infer<typeof approveListingSchema>

/**
 * Body for POST /api/admin/whistleblower/listings/:id/reject
 */
export const rejectListingSchema = z.object({
  reviewedBy: z.string().min(1, 'Reviewer ID is required'),
  reason: z.string().min(1, 'Rejection reason is required'),
})

export type RejectListingRequest = z.infer<typeof rejectListingSchema>

/**
 * Query schema for the public property search (issue #1956). Parameter names
 * follow PropertySearchFilters in frontend/lib/propertiesApi.ts.
 */
export const propertySearchSchema = z.object({
  city: z.string().max(100).optional(),
  area: z.string().max(100).optional(),
  minBedrooms: z.coerce.number().int().min(0).optional(),
  maxBedrooms: z.coerce.number().int().min(0).optional(),
  minBathrooms: z.coerce.number().int().min(0).optional(),
  maxBathrooms: z.coerce.number().int().min(0).optional(),
  minAnnualRent: z.coerce.number().int().min(0).optional(),
  maxAnnualRent: z.coerce.number().int().min(0).optional(),
  query: z.string().max(200).optional(),
  sortBy: z.enum(['price_asc', 'price_desc', 'newest', 'bedrooms_desc']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export type PropertySearchRequest = z.infer<typeof propertySearchSchema>

/** Maximum listing ids accepted by GET /properties?listingIds=. */
export const MAX_PROPERTY_LOOKUP_IDS = 50

/**
 * Query schema for GET /properties. `listingIds` is an optional comma-separated
 * list of listing ids. Without it, the route behaves like the search.
 */
export const propertyListQuerySchema = propertySearchSchema.extend({
  listingIds: z.string().max(2000).optional(),
})

export type PropertyListRequest = z.infer<typeof propertyListQuerySchema>
