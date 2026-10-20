/**
 * Public property routes (issue #1956).
 *
 * The frontend's property search, property detail and saved/compare lookups
 * call /api/properties/*. These routes serve the same data as /api/listings,
 * which stays as a deprecated alias. Responses use the shapes in
 * frontend/lib/propertiesApi.ts (PropertySearchResponse, PropertyDetailResponse).
 *
 * Fields the listing model does not carry are left out rather than filled in:
 *   - amenities: not stored on listings yet, so the field is omitted.
 *   - hasApprovedInspection: taken from listing.hasVerifiedInspection.
 */

import { Router, Request, Response, NextFunction } from 'express'
import { listingStore } from '../models/listingStore.js'
import { ListingStatus, type Listing, type ListingFilters } from '../models/listing.js'
import {
  MAX_PROPERTY_LOOKUP_IDS,
  propertyListQuerySchema,
  propertySearchSchema,
  type PropertySearchRequest,
} from '../schemas/listing.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'

export interface PropertyListing {
  listingId: string
  whistleblowerId: string
  address: string
  city?: string
  area?: string
  bedrooms: number
  bathrooms: number
  annualRentNgn: number
  outrightPriceNgn?: number
  installmentBasePriceNgn?: number
  hasApprovedInspection: boolean
  description?: string
  photos: string[]
  status: string
  createdAt: string
  updatedAt: string
}

export function toPropertyListing(listing: Listing): PropertyListing {
  return {
    listingId: listing.listingId,
    whistleblowerId: listing.whistleblowerId,
    address: listing.address,
    city: listing.city,
    area: listing.area,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    annualRentNgn: listing.annualRentNgn,
    outrightPriceNgn: listing.outrightPriceNgn,
    installmentBasePriceNgn: listing.installmentBasePriceNgn,
    hasApprovedInspection: listing.hasVerifiedInspection ?? false,
    description: listing.description,
    photos: listing.photos,
    status: listing.status,
    createdAt: new Date(listing.createdAt).toISOString(),
    updatedAt: new Date(listing.updatedAt).toISOString(),
  }
}

function searchFilters(query: PropertySearchRequest): ListingFilters {
  return {
    status: ListingStatus.APPROVED,
    q: query.query,
    city: query.city,
    lga: query.area,
    minBedrooms: query.minBedrooms,
    maxBedrooms: query.maxBedrooms,
    minBathrooms: query.minBathrooms,
    maxBathrooms: query.maxBathrooms,
    minAnnualRent: query.minAnnualRent,
    maxAnnualRent: query.maxAnnualRent,
    sortBy: query.sortBy,
    page: query.page,
    pageSize: query.pageSize,
  }
}

function sendError(error: unknown, next: NextFunction) {
  if (error instanceof Error && error.name === 'ZodError') {
    return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
  }
  next(error)
}

export function createPropertiesRouter(): Router {
  const router = Router()

  // GET /properties/search
  // Approved properties with the search filters the frontend sends.
  router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = propertySearchSchema.parse(req.query)
      const result = await listingStore.search(searchFilters(query))

      res.json({
        success: true,
        data: result.listings.map(toPropertyListing),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
      })
    } catch (error) {
      sendError(error, next)
    }
  })

  // GET /properties?listingIds=a,b,c
  // Looks up approved properties by id (used by saved and compare pages).
  // Without listingIds it returns the same results as /search.
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = propertyListQuerySchema.parse(req.query)
      const ids = [
        ...new Set((query.listingIds ?? '').split(',').map((id) => id.trim()).filter(Boolean)),
      ]

      if (ids.length === 0) {
        const result = await listingStore.search(searchFilters(query))
        return res.json({
          success: true,
          data: result.listings.map(toPropertyListing),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          totalPages: result.totalPages,
        })
      }

      if (ids.length > MAX_PROPERTY_LOOKUP_IDS) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          400,
          `At most ${MAX_PROPERTY_LOOKUP_IDS} listingIds can be requested at once`,
        )
      }

      const found = await Promise.all(ids.map((id) => listingStore.getById(id)))
      const approved = found.filter(
        (listing): listing is Listing => listing !== null && listing.status === ListingStatus.APPROVED,
      )
      const start = (query.page - 1) * query.pageSize
      const items = approved.slice(start, start + query.pageSize)

      res.json({
        success: true,
        data: items.map(toPropertyListing),
        total: approved.length,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.ceil(approved.length / query.pageSize),
      })
    } catch (error) {
      sendError(error, next)
    }
  })

  // GET /properties/:id
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const listing = await listingStore.getById(req.params.id)
      if (!listing || listing.status !== ListingStatus.APPROVED) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Property not found')
      }

      res.json({ success: true, data: toPropertyListing(listing) })
    } catch (error) {
      next(error)
    }
  })

  return router
}
