/**
 * Landlord analytics endpoint (#1958).
 *
 * GET /api/v1/landlord/analytics
 *
 * Landlord-only; the caller's own properties are the only ones considered.
 * Accepts an optional `propertyId` and a `startDate`/`endDate` window (capped
 * at 24 months, defaulting to the last 12 months).
 */

import { Router, Response } from 'express'
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import {
  landlordAnalyticsQuerySchema,
  MAX_ANALYTICS_MONTHS,
} from '../schemas/landlordAnalytics.js'
import { computeLandlordAnalytics } from '../services/landlordAnalyticsData.js'

function assertLandlord(req: AuthenticatedRequest): void {
  if (req.user?.role !== 'landlord' && req.user?.role !== 'admin') {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only landlords can access analytics')
  }
}

export function createLandlordAnalyticsRouter(): Router {
  const router = Router()

  router.get(
    '/landlord/analytics',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next) => {
      try {
        assertLandlord(req)
        const landlordId = req.user?.id
        if (!landlordId) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Unauthorized')

        const query = landlordAnalyticsQuerySchema.parse(req.query)

        const end = query.endDate ?? new Date()
        const start = query.startDate ?? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1))

        if (start > end) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            400,
            'startDate must be before endDate',
          )
        }

        const months =
          (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
          (end.getUTCMonth() - start.getUTCMonth()) +
          1
        if (months > MAX_ANALYTICS_MONTHS) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            400,
            `Analytics window cannot exceed ${MAX_ANALYTICS_MONTHS} months`,
          )
        }

        const analytics = await computeLandlordAnalytics({
          landlordId,
          start,
          end,
          propertyId: query.propertyId,
        })

        // Frontend expects the bare LandlordAnalytics object (not wrapped).
        res.json(analytics)
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
