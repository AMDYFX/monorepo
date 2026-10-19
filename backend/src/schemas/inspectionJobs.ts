import { z } from 'zod'
import { INSPECTION_PHOTO_CONTENT_TYPES } from './propertyInspection.js'

/**
 * Schemas for the inspection job board (#1903).
 * Report rules mirror the constraints on inspection_reports (migrations/029):
 * overall_grade A-D, at least 3 photo_keys, notes of at least 20 characters.
 */

export const INSPECTION_JOB_STATUSES = [
  'available',
  'claimed',
  'in_progress',
  'submitted',
  'approved',
  'rejected',
] as const

export const INSPECTION_GRADES = ['A', 'B', 'C', 'D'] as const

export const MIN_INSPECTION_PHOTOS = 3
export const MIN_INSPECTION_NOTES_LENGTH = 20

export const jobIdParamSchema = z.object({
  id: z.string().uuid('Job id must be a UUID'),
})

export const listAvailableJobsQuerySchema = z.object({
  status: z.enum(['available']).default('available'),
  area: z.string().trim().min(1).max(100).optional(),
})

export const adminListJobsQuerySchema = z.object({
  status: z.enum(INSPECTION_JOB_STATUSES).optional(),
})

export const createInspectionJobSchema = z.object({
  listingId: z.string().uuid('listingId must be a UUID'),
  offeredFeeNgn: z
    .number()
    .positive('offeredFeeNgn must be positive')
    .max(1_000_000_000)
    // Tolerance absorbs float error, e.g. 19.99 * 100 is not exactly 1999 in JS.
    .refine(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6,
      'offeredFeeNgn allows at most 2 decimal places',
    ),
})

export type CreateInspectionJobRequest = z.infer<typeof createInspectionJobSchema>

export const rejectInspectionJobSchema = z.object({
  reason: z.string().trim().min(1, 'A rejection reason is required').max(1000),
})

export const presignInspectionJobPhotoSchema = z.object({
  contentType: z.enum(INSPECTION_PHOTO_CONTENT_TYPES),
})

export const submitInspectionReportSchema = z.object({
  overallGrade: z.enum(INSPECTION_GRADES),
  roomChecklist: z.record(z.string().min(1).max(100), z.unknown()),
  photoKeys: z
    .array(z.string().min(1).max(512))
    .min(MIN_INSPECTION_PHOTOS, `At least ${MIN_INSPECTION_PHOTOS} photos are required`)
    .max(50)
    .refine((keys) => new Set(keys).size === keys.length, 'Photo keys must be unique'),
  notes: z
    .string()
    .trim()
    .min(MIN_INSPECTION_NOTES_LENGTH, `Notes must be at least ${MIN_INSPECTION_NOTES_LENGTH} characters`)
    .max(5000),
})

export type SubmitInspectionReportRequest = z.infer<typeof submitInspectionReportSchema>
