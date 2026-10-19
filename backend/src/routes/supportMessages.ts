import { Router, type Request, type Response, type NextFunction } from 'express'
import { createSupportMessageSchema } from '../schemas/supportMessage.js'
import { getSupportMessageStore } from '../models/supportMessageStore.js'
import { createRateLimiter } from '../middleware/rateLimiter.js'
import { rateLimitProfiles } from '../config/rateLimitConfig.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { logger } from '../utils/logger.js'

const router = Router()
const supportMessageStore = getSupportMessageStore()

// Rate limiter for public POST endpoint
const publicRateLimiter = createRateLimiter({
  points: 5,
  duration: 60 * 60, // 1 hour
  keyPrefix: 'rl:support_message',
  keyBy: 'ip',
})

/**
 * POST /api/v1/support/messages
 * Submit a support/contact message (public, no auth, rate-limited by IP)
 */
router.post('/', publicRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = createSupportMessageSchema.parse(req.body)

    const message = await supportMessageStore.create({
      name: validated.name,
      email: validated.email,
      phone: validated.phone ?? null,
      subject: validated.subject,
      message: validated.message,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    })

    logger.info('[support] Message received', {
      messageId: message.messageId,
      email: message.email,
    })

    res.status(201).json({
      success: true,
      messageId: message.messageId,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'ZodError') {
      return next(new AppError(ErrorCode.VALIDATION_ERROR, 400, error.message))
    }
    next(error)
  }
})

/**
 * GET /api/v1/admin/support/messages
 * List support messages (admin-only, paginated, newest first)
 */
router.get(
  '/',
  authenticateToken,
  requirePermission('support', 'view'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 50))

      const result = await supportMessageStore.list(page, pageSize)

      res.json({
        success: true,
        data: result.messages,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages: result.totalPages,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

export function createSupportMessagesRouter(): Router {
  return router
}
