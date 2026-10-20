/**
 * Review-time monthly repayment for a listing application (issue #1953).
 *
 * The RTI check needs the instalment the tenant would actually pay. It is
 * derived with the same schedule generator the deal uses on activation
 * (`generateSchedule` in repaymentScheduleService), so the first instalment
 * shown to reviewers matches the deal's first instalment for the same inputs.
 *
 * Applications do not carry a deposit. The review therefore assumes the
 * minimum deposit (20% of annual rent, the floor enforced by createDealSchema).
 * A smaller deposit means a larger financed balance and a higher instalment,
 * so this is the conservative assumption for affordability.
 *
 * Schedule amounts are integer kobo, so the result is divided by 100 to get
 * NGN, the unit that income is stored in.
 */

import { generateSchedule, type RepaymentPlan } from './repaymentScheduleService.js'
import { PaymentPlan } from '../models/listingApplication.js'

export const REVIEW_DEPOSIT_PERCENT = 20

const KOBO_PER_NGN = 100

const PLAN_TERMS: Partial<Record<PaymentPlan, { plan: RepaymentPlan; termMonths: number }>> = {
  [PaymentPlan.THREE_MONTHS]: { plan: '3m', termMonths: 3 },
  [PaymentPlan.SIX_MONTHS]: { plan: '6m', termMonths: 6 },
  [PaymentPlan.TWELVE_MONTHS]: { plan: '12m', termMonths: 12 },
}

export interface RepaymentBasis {
  annualRentNgn: number
  depositPercent: number
  termMonths: number
}

export type ReviewRepaymentUnavailableReason = 'outright_plan' | 'missing_rent'

export type ReviewRepayment =
  | { available: true; monthlyRepayment: number; basis: RepaymentBasis }
  | { available: false; reason: ReviewRepaymentUnavailableReason }

/**
 * Derive the first monthly instalment (NGN) for a listing application.
 *
 * - Outright applications have no instalments, so no RTI is produced.
 * - A missing listing or non-positive annual rent cannot be priced, so no RTI
 *   is produced. The caller records the reason instead of a placeholder value.
 */
export function deriveReviewRepayment(input: {
  annualRentNgn: number | null | undefined
  paymentPlan: PaymentPlan
}): ReviewRepayment {
  const terms = PLAN_TERMS[input.paymentPlan]
  if (!terms) {
    return { available: false, reason: 'outright_plan' }
  }

  const annualRentNgn = input.annualRentNgn
  if (annualRentNgn == null || !Number.isFinite(annualRentNgn) || annualRentNgn <= 0) {
    return { available: false, reason: 'missing_rent' }
  }

  const { schedule } = generateSchedule({
    dealId: 'listing-application-review',
    startDate: new Date(),
    plan: terms.plan,
    installmentBasePriceNgn: annualRentNgn,
    depositPct: REVIEW_DEPOSIT_PERCENT,
  })

  return {
    available: true,
    monthlyRepayment: schedule[0].totalAmountNgn / KOBO_PER_NGN,
    basis: {
      annualRentNgn,
      depositPercent: REVIEW_DEPOSIT_PERCENT,
      termMonths: terms.termMonths,
    },
  }
}
