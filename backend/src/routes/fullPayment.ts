/**
 * Full-payment preview/confirm endpoints (#1961).
 *
 * Mounted at the same base as the existing payments router
 * (`/api/v1/payments`); the `/:paymentId/full-payment/*` paths do not collide
 * with `/confirm`.
 *
 * `paymentId` is a deal id (the tenant payments page passes `selectedDeal`).
 */

import { Router, Response } from 'express'
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js'
import { durableIdempotency } from '../middleware/durableIdempotency.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { previewFullPayment, confirmFullPayment } from '../services/fullPaymentService.js'

export function createFullPaymentRouter(): Router {
  const router = Router()

  router.get(
    '/:paymentId/full-payment/preview',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next) => {
      try {
        const tenantId = req.user?.id
        if (!tenantId) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Unauthorized')

        const preview = await previewFullPayment({
          dealId: req.params.paymentId,
          tenantId,
        })

        // Frontend expects the bare FullPaymentPreview object (not wrapped).
        res.json(preview)
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/:paymentId/full-payment/confirm',
    authenticateToken,
    durableIdempotency((req) => `full-payment:${req.params.paymentId}`),
    async (req: AuthenticatedRequest, res: Response, next) => {
      try {
        const tenantId = req.user?.id
        if (!tenantId) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Unauthorized')

        const receipt = await confirmFullPayment({
          dealId: req.params.paymentId,
          tenantId,
        })

        // Frontend expects the bare FullPaymentReceipt object (not wrapped).
        res.json(receipt)
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
