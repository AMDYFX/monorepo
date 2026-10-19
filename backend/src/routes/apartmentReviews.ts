import { Router, type Request, type Response, type NextFunction } from 'express'
import { createApartmentReviewSchema } from '../schemas/apartmentReview.js'
import { getApartmentReviewStore } from '../models/apartmentReviewStore.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { getPool } from '../db.js'

const router = Router()
const reviewStore = getApartmentReviewStore()

/**
 * GET /api/v1/apartment-reviews
 * List apartment reviews with filters, sorting and pagination (public)
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apartmentId = req.query.apartmentId as string
    const rating = req.query.rating ? parseInt(req.query.rating as string) : undefined
    const verifiedStay = req.query.verifiedStay === 'true'
    const sortBy = (req.query.sortBy as string) || 'newest'
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 10))

    // Validate sortBy
    const validSorts = ['newest', 'oldest', 'rating_desc', 'rating_asc']
    if (!validSorts.includes(sortBy)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Invalid sortBy value')
    }

    // Validate rating if provided
    if (rating !== undefined && (rating < 1 || rating > 5)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Rating must be between 1 and 5')
    }

    const result = await reviewStore.list(
      {
        apartmentId,
        rating,
        verifiedStay: verifiedStay || undefined,
        sortBy: sortBy as any,
      },
      page,
      pageSize,
    )

    res.json({
      reviews: result.reviews,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
      aggregateRating: result.aggregateRating,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * POST /api/v1/apartment-reviews
 * Create a new review (authenticated)
 */
router.post('/', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.userId
    if (!userId) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'User not authenticated')
    }

    const validated = createApartmentReviewSchema.parse(req.body)

    // Check for duplicate review
    const existing = await reviewStore.findByUserAndApartment(userId, validated.apartmentId)
    if (existing) {
      throw new AppError(ErrorCode.CONFLICT, 409, 'You have already reviewed this apartment')
    }

    // Determine verified_stay: check if user has completed or active deal for this property
    let verifiedStay = false
    const pool = await getPool()
    if (pool) {
      const dealResult = await pool.query(
        `SELECT d.id FROM deals d
         INNER JOIN landlord_properties lp ON d.property_id = lp.id
         WHERE d.user_id = $1 AND lp.id = $2 AND d.status IN ('completed', 'active')
         LIMIT 1`,
        [userId, validated.apartmentId],
      )
      verifiedStay = dealResult.rows.length > 0
    }

    const review = await reviewStore.create({
      apartmentId: validated.apartmentId,
      userId,
      rating: validated.rating,
      content: validated.content,
      verifiedStay,
    })

    res.status(201).json({
      success: true,
      data: review,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * POST /api/v1/apartment-reviews/:id/report
 * Mark a review as reported (authenticated)
 */
router.post('/:id/report', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params

    const review = await reviewStore.findById(id)
    if (!review) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, 'Review not found')
    }

    await reviewStore.markReported(id)

    res.json({ success: true })
  } catch (error) {
    next(error)
  }
})

/**
 * PATCH /api/v1/admin/apartment-reviews/:id
 * Admin: hide/unhide a review (requires listings:moderate permission)
 */
router.patch(
  '/:id',
  authenticateToken,
  requirePermission('listings', 'moderate'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params
      const { isHidden } = req.body

      if (typeof isHidden !== 'boolean') {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'isHidden must be a boolean')
      }

      const review = await reviewStore.findById(id)
      if (!review) {
        throw new AppError(ErrorCode.NOT_FOUND, 404, 'Review not found')
      }

      await reviewStore.setHidden(id, isHidden)

      res.json({ success: true })
    } catch (error) {
      next(error)
    }
  },
)

export function createApartmentReviewsRouter(): Router {
  return router
}
