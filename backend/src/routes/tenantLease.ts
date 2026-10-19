/**
 * Tenant lease endpoints (#1959).
 *
 * - GET /tenant/lease/current          → summary of the tenant's active lease
 * - GET /tenant/deals/:dealId/lease    → full lease details for one deal
 * - GET /tenant/deals/:dealId/documents→ lease documents attached to a deal
 *
 * All reads are tenant-scoped: a deal that belongs to another user (or does not
 * exist) yields 404 so tenants cannot probe for other people's leases.
 */

import { Router, Response } from 'express'
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth.js'
import { dealStore } from '../models/dealStore.js'
import { listingStore } from '../models/listingStore.js'
import { userStore } from '../models/authStore.js'
import { DealStatus } from '../models/deal.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { getTenantDocumentVaultStore } from '../models/tenantDocumentVaultStore.js'
import type { TenantDocumentResponse } from '../schemas/tenantDocument.js'

interface DealLike {
  dealId: string
  tenantId: string
  landlordId: string
  listingId?: string
  annualRentNgn: number
  depositNgn: number
  financedAmountNgn: number
  termMonths: number
  createdAt: Date
  status: DealStatus
  schedule: Array<{ period: number; dueDate: string; amountNgn: number; status: string }>
}

function notFound(): AppError {
  return new AppError(ErrorCode.NOT_FOUND, 404, 'No active lease found')
}

/** Human-readable lease duration, e.g. "12 months". */
function formatDuration(termMonths: number): string {
  return `${termMonths} month${termMonths === 1 ? '' : 's'}`
}

function monthsBetween(start: Date, end: Date): number {
  return (
    (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth())
  )
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date)
  next.setMonth(next.getMonth() + months)
  return next
}

/**
 * Tenant-scoped lookup. Returns the deal with its schedule, or throws 404 when
 * the deal is missing or belongs to another tenant.
 */
async function requireOwnedDeal(dealId: string, tenantId: string): Promise<DealLike> {
  const deal = await dealStore.findById(dealId)
  if (!deal || deal.tenantId !== tenantId) {
    throw new AppError(ErrorCode.NOT_FOUND, 404, 'Deal not found')
  }
  return deal
}

function summariseSchedule(schedule: DealLike['schedule']) {
  const paid = schedule.filter((item) => item.status === 'paid')
  const totalPaid = paid.reduce((sum, item) => sum + item.amountNgn, 0)
  const totalOwed = schedule.reduce((sum, item) => sum + item.amountNgn, 0)
  const next = schedule.find((item) => item.status !== 'paid')
  return { totalPaid, totalOwed, paymentsCompleted: paid.length, next }
}

export function createTenantLeaseRouter(): Router {
  const router = Router()

  router.get(
    '/tenant/lease/current',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next) => {
      try {
        const tenantId = req.user?.id
        if (!tenantId) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Unauthorized')

        const { deals } = await dealStore.findMany({ tenantId, pageSize: 100 })
        const active = deals.find((deal) => deal.status === DealStatus.ACTIVE)
        if (!active) throw notFound()

        const deal = await dealStore.findById(active.dealId)
        if (!deal) throw notFound()

        const listing = deal.listingId ? await listingStore.getById(deal.listingId) : null
        const landlord = await userStore.getById(deal.landlordId)

        const { totalPaid, totalOwed, next } = summariseSchedule(deal.schedule)
        const leaseEnd = addMonths(deal.createdAt, deal.termMonths)
        const progress = totalOwed === 0 ? 0 : Math.round((totalPaid / totalOwed) * 100)

        res.json({
          success: true,
          data: {
            dealId: deal.dealId,
            property: listing?.address ?? 'Rental property',
            location: [listing?.area, listing?.city].filter(Boolean).join(', '),
            monthlyPayment: Math.round(deal.financedAmountNgn / deal.termMonths),
            nextPaymentDate: next?.dueDate ?? '',
            leaseEnd: leaseEnd.toISOString(),
            totalPaid,
            totalOwed,
            progress,
            landlord: { name: landlord?.name ?? 'Landlord' },
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/tenant/deals/:dealId/lease',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next) => {
      try {
        const tenantId = req.user?.id
        if (!tenantId) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Unauthorized')

        const deal = await requireOwnedDeal(req.params.dealId, tenantId)
        const listing = deal.listingId ? await listingStore.getById(deal.listingId) : null
        const landlord = await userStore.getById(deal.landlordId)
        const landlordProfile = await userStore.getLandlordProfile(deal.landlordId)

        const { totalPaid, totalOwed, paymentsCompleted } = summariseSchedule(deal.schedule)
        const duration = monthsBetween(deal.createdAt, addMonths(deal.createdAt, deal.termMonths))

        res.json({
          success: true,
          data: {
            dealId: deal.dealId,
            property: {
              title: listing?.address ?? 'Rental property',
              address: [listing?.address, listing?.area, listing?.city]
                .filter(Boolean)
                .join(', '),
              beds: listing?.bedrooms ?? 0,
              baths: listing?.bathrooms ?? 0,
              // Listing has no square-metre field yet; kept at 0 until the
              // property schema grows one (see PR notes for #1959).
              sqm: 0,
            },
            lease: {
              startDate: deal.createdAt.toISOString(),
              endDate: addMonths(deal.createdAt, deal.termMonths).toISOString(),
              duration: formatDuration(duration),
              monthlyPayment: Math.round(deal.financedAmountNgn / deal.termMonths),
              status: deal.status,
            },
            landlord: {
              name: landlord?.name ?? 'Landlord',
              ...(landlordProfile?.companyName ? { company: landlordProfile.companyName } : {}),
              phone: landlordProfile?.phone ?? '',
              email: landlord?.email ?? '',
            },
            paymentProgress: {
              totalPaid,
              totalOwed,
              paymentsCompleted,
              totalPayments: deal.schedule.length,
            },
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/tenant/deals/:dealId/documents',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next) => {
      try {
        const tenantId = req.user?.id
        if (!tenantId) throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Unauthorized')

        await requireOwnedDeal(req.params.dealId, tenantId)

        const { documents } = await getTenantDocumentVaultStore().list(tenantId, {
          dealId: req.params.dealId,
          page: 1,
          pageSize: 100,
        })


        res.json({
          success: true,
          data: documents.map((doc: TenantDocumentResponse) => ({
            id: doc.id,
            name: doc.fileName,
            date: doc.createdAt,
            type: doc.category,
            size: `${doc.fileSizeBytes} bytes`,
            status: 'available',
          })),
        })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
