import { z } from 'zod'

export const createApartmentReviewSchema = z.object({
  apartmentId: z.string().uuid('Invalid apartment ID'),
  rating: z.number().int().min(1, 'Rating must be between 1 and 5').max(5, 'Rating must be between 1 and 5'),
  content: z.string().min(1, 'Review content is required').max(5000, 'Review content must be at most 5000 characters'),
})

export type CreateApartmentReviewRequest = z.infer<typeof createApartmentReviewSchema>

export interface ApartmentReview {
  id: string
  apartmentId: string
  userId: string
  userName?: string
  rating: number
  content: string
  verifiedStay: boolean
  isHidden: boolean
  isReported: boolean
  helpfulCount: number
  createdAt: Date
  updatedAt: Date
}

export interface ApartmentReviewsListResult {
  reviews: ApartmentReview[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  aggregateRating: number | null
}

export interface ListApartmentReviewsFilters {
  apartmentId?: string
  rating?: number
  verifiedStay?: boolean
  sortBy?: 'newest' | 'oldest' | 'rating_desc' | 'rating_asc'
}
