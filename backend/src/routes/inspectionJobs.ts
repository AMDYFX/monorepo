/**
 * Inspection job board routes — issue #1903.
 *
 * All routes are gated by requireFlag('INSPECTOR_DASHBOARD_ENABLED').
 *
 * Inspector (mounted at /api/v1/inspector/jobs; verified inspectors only):
 *   GET  /?status=available&area=       available jobs in the inspector's service areas
 *   POST /:id/claim                     atomic claim; sets a claim deadline
 *   GET  /mine                          jobs the inspector has claimed or submitted
 *   POST /:id/photos/presign            presigned upload URL for a report photo
 *   POST /:id/report                    submit the report; moves the job to submitted
 *
 * Admin (mounted at /api/v1/admin/inspector/jobs; inspections:review):
 *   GET  /?status=submitted             list jobs
 *   POST /                              create a job for a listing
 *   POST /:id/approve                   approve a submitted job
 *   POST /:id/reject  { reason }        reject a submitted job
 *
 * A claim whose deadline passes is released back to available by
 * jobs/inspectionClaimExpiryJob.ts.
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requireFlag } from '../middleware/requireFlag.js'
import { requireVerifiedInspector } from '../middleware/requireVerifiedInspector.js'
import { requirePermission } from '../middleware/rbac.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { inspectorProfileStore } from '../models/inspectorProfileStore.js'
import {
  inspectionJobStore,
  type InspectionJob,
  type InspectionJobDetail,
  type InspectionJobStatus,
} from '../models/inspectionJobStore.js'
import { listingStore } from '../models/listingStore.js'
import { ListingStatus } from '../models/listing.js'
import {
  claimDeadlineFrom,
  getClaimWindowMs,
  isClaimLive,
  isInServiceArea,
  photoKeysBelongToJob,
} from '../services/inspectionJobs.js'
import {
  buildInspectionReportObjectKey,
  generatePresignedUpload,
} from '../services/storageService.js'
import {
  adminListJobsQuerySchema,
  createInspectionJobSchema,
  jobIdParamSchema,
  listAvailableJobsQuerySchema,
  presignInspectionJobPhotoSchema,
  rejectInspectionJobSchema,
  submitInspectionReportSchema,
  type CreateInspectionJobRequest,
  type SubmitInspectionReportRequest,
} from '../schemas/inspectionJobs.js'
import { auditLog, extractAuditContext } from '../utils/auditLogger.js'

function requireUser(req: AuthenticatedRequest) {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  return req.user
}

function toJobDto(job: InspectionJob | InspectionJobDetail, listingArea?: string | null) {
  return {
    id: job.id,
    listingId: job.listingId,
    listingArea: 'listingArea' in job ? job.listingArea : (listingArea ?? null),
    status: job.status,
    offeredFeeNgn: job.offeredFeeNgn,
    inspectorId: job.inspectorId,
    claimDeadline: job.claimDeadline?.toISOString() ?? null,
    submittedAt: job.submittedAt?.toISOString() ?? null,
    approvedAt: job.approvedAt?.toISOString() ?? null,
    rejectionReason: job.rejectionReason,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  }
}

/**
 * Loads a job the caller holds a live claim on. Used by the presign and report
 * routes, so a claim that has lapsed cannot upload photos or submit a report.
 */
async function requireLiveClaim(jobId: string, inspectorId: string, now: Date): Promise<InspectionJobDetail> {
  const job = await inspectionJobStore.findById(jobId)
  if (!job) {
    throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspection job not found')
  }
  if (job.status !== 'claimed') {
    throw new AppError(ErrorCode.CONFLICT, 409, `Inspection job is ${job.status}, not claimed`)
  }
  if (job.inspectorId !== inspectorId) {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Only the inspector who claimed this job can do this')
  }
  if (!isClaimLive(job.claimDeadline, now)) {
    throw new AppError(ErrorCode.CONFLICT, 409, 'The claim deadline for this job has passed')
  }
  return job
}

export function createInspectorJobsRouter(): Router {
  const router = Router()
  router.use(requireFlag('INSPECTOR_DASHBOARD_ENABLED'))

  router.get(
    '/',
    authenticateToken,
    requireVerifiedInspector,
    validate(listAvailableJobsQuerySchema, 'query'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const { area } = req.query as { area?: string }
        const profile = await inspectorProfileStore.getByUserId(user.id)
        const serviceAreas = profile?.serviceAreas ?? []
        const areas = area ? serviceAreas.filter((serviceArea) => isInServiceArea(area, [serviceArea])) : serviceAreas
        const jobs = await inspectionJobStore.listAvailable(areas)
        res.json({ success: true, data: jobs.map((job) => toJobDto(job)) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/mine',
    authenticateToken,
    requireVerifiedInspector,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const jobs = await inspectionJobStore.listForInspector(user.id)
        res.json({ success: true, data: jobs.map((job) => toJobDto(job)) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/:id/claim',
    authenticateToken,
    requireVerifiedInspector,
    validate(jobIdParamSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const { id } = req.params

        const job = await inspectionJobStore.findById(id)
        if (!job) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspection job not found')
        }
        if (job.status !== 'available') {
          throw new AppError(ErrorCode.CONFLICT, 409, 'Inspection job is no longer available')
        }

        const profile = await inspectorProfileStore.getByUserId(user.id)
        if (!isInServiceArea(job.listingArea, profile?.serviceAreas ?? [])) {
          throw new AppError(ErrorCode.FORBIDDEN, 403, 'This job is outside your service areas')
        }

        // The store's conditional UPDATE decides the race; a loser gets 409 here.
        const now = new Date()
        const claimed = await inspectionJobStore.claim(
          id,
          user.id,
          claimDeadlineFrom(now, getClaimWindowMs(process.env)),
          now,
        )
        if (!claimed) {
          throw new AppError(ErrorCode.CONFLICT, 409, 'Inspection job was claimed by another inspector')
        }

        auditLog('INSPECTION_JOB_CLAIMED', extractAuditContext(req, 'user'), {
          jobId: id,
          inspectorId: user.id,
        })

        res.json({ success: true, data: toJobDto(claimed, job.listingArea) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/:id/photos/presign',
    authenticateToken,
    requireVerifiedInspector,
    validate(jobIdParamSchema, 'params'),
    validate(presignInspectionJobPhotoSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const { id } = req.params
        const { contentType } = req.body as { contentType: string }

        await requireLiveClaim(id, user.id, new Date())

        const objectKey = buildInspectionReportObjectKey(id, contentType)
        const { uploadUrl, expiresAt } = await generatePresignedUpload(objectKey, contentType)
        res.json({ success: true, data: { uploadUrl, objectKey, expiresAt } })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/:id/report',
    authenticateToken,
    requireVerifiedInspector,
    validate(jobIdParamSchema, 'params'),
    validate(submitInspectionReportSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req)
        const { id } = req.params
        const body = req.body as SubmitInspectionReportRequest

        const now = new Date()
        await requireLiveClaim(id, user.id, now)

        if (!photoKeysBelongToJob(id, body.photoKeys)) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            400,
            'Photo keys must come from the photo presign endpoint for this job',
          )
        }

        const submitted = await inspectionJobStore.submitReport(
          id,
          user.id,
          {
            overallGrade: body.overallGrade,
            roomChecklist: body.roomChecklist,
            photoKeys: body.photoKeys,
            notes: body.notes,
          },
          now,
        )
        if (!submitted) {
          throw new AppError(ErrorCode.CONFLICT, 409, 'Inspection job can no longer accept a report')
        }

        auditLog('INSPECTION_JOB_REPORT_SUBMITTED', extractAuditContext(req, 'user'), {
          jobId: id,
          inspectorId: user.id,
          overallGrade: body.overallGrade,
        })

        res.status(201).json({
          success: true,
          data: { jobId: id, status: 'submitted', overallGrade: body.overallGrade, submittedAt: now.toISOString() },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}

export function createAdminInspectionJobsRouter(): Router {
  const router = Router()
  router.use(requireFlag('INSPECTOR_DASHBOARD_ENABLED'))

  router.get(
    '/',
    authenticateToken,
    requirePermission('inspections', 'review'),
    validate(adminListJobsQuerySchema, 'query'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { status } = req.query as { status?: InspectionJobStatus }
        const jobs = await inspectionJobStore.listByStatus(status)
        res.json({ success: true, data: jobs.map((job) => toJobDto(job)) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/',
    authenticateToken,
    requirePermission('inspections', 'review'),
    validate(createInspectionJobSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const admin = requireUser(req)
        const body = req.body as CreateInspectionJobRequest

        const listing = await listingStore.getById(body.listingId)
        if (!listing) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Listing not found')
        }
        if (listing.status === ListingStatus.REJECTED || listing.status === ListingStatus.RENTED) {
          throw new AppError(ErrorCode.CONFLICT, 409, 'Only pending or approved listings can be inspected')
        }

        const open = await inspectionJobStore.findOpenForListing(body.listingId)
        if (open) {
          throw new AppError(ErrorCode.CONFLICT, 409, 'An open inspection job already exists for this listing')
        }

        const job = await inspectionJobStore.create({
          listingId: body.listingId,
          offeredFeeNgn: body.offeredFeeNgn,
          now: new Date(),
        })

        auditLog('INSPECTION_JOB_CREATED', extractAuditContext(req, 'admin'), {
          jobId: job.id,
          listingId: body.listingId,
          adminId: admin.id,
        })

        res.status(201).json({ success: true, data: toJobDto(job, listing.area ?? null) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/:id/approve',
    authenticateToken,
    requirePermission('inspections', 'review'),
    validate(jobIdParamSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const admin = requireUser(req)
        const { id } = req.params

        const existing = await inspectionJobStore.findById(id)
        if (!existing) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspection job not found')
        }
        const approved = await inspectionJobStore.review(id, 'approved', new Date())
        if (!approved) {
          throw new AppError(ErrorCode.CONFLICT, 409, 'Only submitted inspection jobs can be approved')
        }

        auditLog('INSPECTION_JOB_APPROVED', extractAuditContext(req, 'admin'), {
          jobId: id,
          adminId: admin.id,
        })

        res.json({ success: true, data: toJobDto(approved, existing.listingArea) })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/:id/reject',
    authenticateToken,
    requirePermission('inspections', 'review'),
    validate(jobIdParamSchema, 'params'),
    validate(rejectInspectionJobSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const admin = requireUser(req)
        const { id } = req.params
        const { reason } = req.body as { reason: string }

        const existing = await inspectionJobStore.findById(id)
        if (!existing) {
          throw new AppError(ErrorCode.NOT_FOUND, 404, 'Inspection job not found')
        }
        const rejected = await inspectionJobStore.review(id, 'rejected', new Date(), reason)
        if (!rejected) {
          throw new AppError(ErrorCode.CONFLICT, 409, 'Only submitted inspection jobs can be rejected')
        }

        auditLog('INSPECTION_JOB_REJECTED', extractAuditContext(req, 'admin'), {
          jobId: id,
          adminId: admin.id,
        })

        res.json({ success: true, data: toJobDto(rejected, existing.listingArea) })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
