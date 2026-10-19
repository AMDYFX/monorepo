/**
 * Tenant saved-property routes (#1889). Saving and removing are idempotent, and
 * each caller only sees and changes their own list. The response shapes match
 * frontend/lib/savedPropertiesApi.ts.
 *
 *   GET    /api/v1/tenant/saved-properties             listing ids the caller has saved
 *   POST   /api/v1/tenant/saved-properties/:listingId  save a listing (404 if it does not exist)
 *   DELETE /api/v1/tenant/saved-properties/:listingId  unsave a listing
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { listingStore } from '../models/listingStore.js'
import { savedPropertyStore } from '../models/savedPropertyStore.js'
import { savedPropertyParamsSchema } from '../schemas/tenantSavedProperties.js'

function currentUserId(req: AuthenticatedRequest): string {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  return req.user.id
}

export function createTenantSavedPropertiesRouter(): Router {
  const router = Router()

  router.get(
    '/',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const listingIds = await savedPropertyStore.listListingIds(currentUserId(req))
        res.json({ success: true, data: listingIds })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/:listingId',
    authenticateToken,
    validate(savedPropertyParamsSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = currentUserId(req)
        const { listingId } = req.params

        const listing = await listingStore.getById(listingId)
        if (!listing) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Listing not found')
        }

        await savedPropertyStore.save(userId, listingId)
        res.json({ success: true, data: { listingId, saved: true } })
      } catch (error) {
        next(error)
      }
    },
  )

  router.delete(
    '/:listingId',
    authenticateToken,
    validate(savedPropertyParamsSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = currentUserId(req)
        const { listingId } = req.params

        // No existence check here, so that listings removed since being saved can still be unsaved.
        await savedPropertyStore.remove(userId, listingId)
        res.json({ success: true, data: { listingId, saved: false } })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
