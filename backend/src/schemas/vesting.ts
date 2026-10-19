import { z } from 'zod'
import { StrKey } from '@stellar/stellar-sdk'

const stellarAccount = z
  .string()
  .refine((value) => StrKey.isValidEd25519PublicKey(value), {
    message: 'Must be a Stellar account address (G...)',
  })

/** Largest i128 value, the largest amount the vesting contract accepts. */
const I128_MAX = (BigInt(1) << BigInt(127)) - BigInt(1)

export const createVestingScheduleSchema = z
  .object({
    beneficiary: stellarAccount,
    totalAmount: z
      .string()
      .regex(/^[1-9]\d*$/, 'Must be a positive integer in token base units')
      .refine((value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= I128_MAX, {
        message: 'Amount exceeds the maximum token amount',
      }),
    startTime: z.number().int().nonnegative(),
    cliffTime: z.number().int().nonnegative(),
    endTime: z.number().int().nonnegative(),
    revocable: z.boolean(),
  })
  .refine(
    (value) =>
      value.startTime < value.endTime &&
      value.startTime <= value.cliffTime &&
      value.cliffTime <= value.endTime,
    {
      message: 'Times must satisfy startTime < endTime and startTime <= cliffTime <= endTime',
    },
  )

export const submitVestingClaimSchema = z.object({
  signedXdr: z.string().min(1).max(20_000),
})

export const vestingBeneficiaryParamsSchema = z.object({
  beneficiary: stellarAccount,
})

export type CreateVestingScheduleRequest = z.infer<typeof createVestingScheduleSchema>
