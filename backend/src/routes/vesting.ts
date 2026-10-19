/**
 * Vesting routes (#1911). A beneficiary reads their schedule and claims by
 * signing a transaction in their own wallet. Admins create and revoke
 * schedules, which are signed with the admin key.
 *
 *   GET  /api/v1/vesting/me                          schedule and claimable amount for the linked wallet
 *   POST /api/v1/vesting/claim/prepare               unsigned claim transaction (XDR) for the wallet to sign
 *   POST /api/v1/vesting/claim/submit                submit the wallet-signed claim
 *   POST /api/v1/admin/vesting                       create a schedule (vesting:manage)
 *   POST /api/v1/admin/vesting/:beneficiary/revoke   revoke a revocable schedule (vesting:manage)
 *
 * Amounts are returned as decimal strings, since they are i128 values.
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import type { LinkedAddressStore } from '../models/linkedAddressStore.js'
import type { SorobanAdapter, VestingScheduleRecord } from '../soroban/adapter.js'
import {
  createVestingScheduleSchema,
  submitVestingClaimSchema,
  vestingBeneficiaryParamsSchema,
  type CreateVestingScheduleRequest,
} from '../schemas/vesting.js'

type VestingMethod =
  | 'createVestingSchedule'
  | 'revokeVesting'
  | 'getVestingSchedule'
  | 'getClaimableVested'
  | 'prepareVestingClaim'
  | 'submitVestingClaim'

const VESTING_METHODS: VestingMethod[] = [
  'createVestingSchedule',
  'revokeVesting',
  'getVestingSchedule',
  'getClaimableVested',
  'prepareVestingClaim',
  'submitVestingClaim',
]

type VestingAdapter = SorobanAdapter & Required<Pick<SorobanAdapter, VestingMethod>>

function requireVesting(adapter: SorobanAdapter): VestingAdapter {
  if (VESTING_METHODS.some((name) => typeof adapter[name] !== 'function')) {
    throw new AppError(
      ErrorCode.NOT_IMPLEMENTED,
      501,
      'Vesting is not available on the configured Soroban adapter',
    )
  }
  return adapter as VestingAdapter
}

function currentUserId(req: AuthenticatedRequest): string {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  return req.user.id
}

async function requireLinkedWallet(store: LinkedAddressStore, userId: string): Promise<string> {
  const wallet = await store.getLinkedAddress(userId)
  if (!wallet) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'No linked wallet address found for user')
  }
  return wallet
}

function toScheduleDto(schedule: VestingScheduleRecord) {
  return {
    totalAmount: schedule.totalAmount.toString(),
    claimedAmount: schedule.claimedAmount.toString(),
    startTime: schedule.startTime,
    cliffTime: schedule.cliffTime,
    endTime: schedule.endTime,
    revocable: schedule.revocable,
    revoked: schedule.revoked,
  }
}

export function createVestingRouter(
  sorobanAdapter: SorobanAdapter,
  linkedAddressStore: LinkedAddressStore,
): Router {
  const router = Router()

  router.get(
    '/me',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const vesting = requireVesting(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))
        const [schedule, claimable] = await Promise.all([
          vesting.getVestingSchedule(wallet),
          vesting.getClaimableVested(wallet),
        ])

        res.json({
          success: true,
          data: {
            beneficiary: wallet,
            schedule: schedule ? toScheduleDto(schedule) : null,
            claimable: claimable.toString(),
          },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/claim/prepare',
    authenticateToken,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const vesting = requireVesting(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))

        if ((await vesting.getClaimableVested(wallet)) <= BigInt(0)) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'Nothing vested to claim')
        }

        const xdr = await vesting.prepareVestingClaim(wallet)
        res.json({ success: true, data: { xdr } })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/claim/submit',
    authenticateToken,
    validate(submitVestingClaimSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const vesting = requireVesting(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))
        const { signedXdr } = req.body as { signedXdr: string }

        const txHash = await vesting.submitVestingClaim(signedXdr, wallet)
        res.json({ success: true, data: { txHash } })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}

export function createAdminVestingRouter(sorobanAdapter: SorobanAdapter): Router {
  const router = Router()

  router.post(
    '/',
    authenticateToken,
    requirePermission('vesting', 'manage'),
    validate(createVestingScheduleSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const vesting = requireVesting(sorobanAdapter)
        const body = req.body as CreateVestingScheduleRequest

        const txHash = await vesting.createVestingSchedule({
          beneficiary: body.beneficiary,
          totalAmount: BigInt(body.totalAmount),
          startTime: body.startTime,
          cliffTime: body.cliffTime,
          endTime: body.endTime,
          revocable: body.revocable,
        })
        res.status(201).json({ success: true, data: { beneficiary: body.beneficiary, txHash } })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/:beneficiary/revoke',
    authenticateToken,
    requirePermission('vesting', 'manage'),
    validate(vestingBeneficiaryParamsSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const vesting = requireVesting(sorobanAdapter)
        const { beneficiary } = req.params

        const txHash = await vesting.revokeVesting(beneficiary)
        res.json({ success: true, data: { beneficiary, txHash } })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
