import { describe, it, expect } from 'vitest'
import { deriveReviewRepayment, REVIEW_DEPOSIT_PERCENT } from './reviewRepayment.js'
import { generateSchedule } from './repaymentScheduleService.js'
import { PaymentPlan } from '../models/listingApplication.js'

describe('deriveReviewRepayment', () => {
  it('prices the first instalment for a 12-month plan (₦2,400,000 rent, 20% deposit, 15% p.a.)', () => {
    // Financed ₦1,920,000 + ₦288,000 interest = ₦2,208,000, over 12 instalments.
    const result = deriveReviewRepayment({
      annualRentNgn: 2_400_000,
      paymentPlan: PaymentPlan.TWELVE_MONTHS,
    })

    expect(result).toEqual({
      available: true,
      monthlyRepayment: 184_000,
      basis: { annualRentNgn: 2_400_000, depositPercent: 20, termMonths: 12 },
    })
  })

  it('prices the first instalment for a 3-month plan (8% tier)', () => {
    // Financed ₦1,920,000 + ₦38,400 interest = ₦1,958,400, over 3 instalments.
    const result = deriveReviewRepayment({
      annualRentNgn: 2_400_000,
      paymentPlan: PaymentPlan.THREE_MONTHS,
    })

    expect(result.available).toBe(true)
    if (result.available) {
      expect(result.monthlyRepayment).toBe(652_800)
      expect(result.basis.termMonths).toBe(3)
    }
  })

  it('matches the first instalment the deal schedule produces for the same inputs', () => {
    // Deal activation calls generateSchedule with the listing rent, the deposit
    // percentage and the plan for the term. Amounts are integer kobo, so the
    // NGN value must equal that first instalment divided by 100.
    const annualRentNgn = 1_750_000
    const plans: Array<[PaymentPlan, '3m' | '6m' | '12m', number]> = [
      [PaymentPlan.THREE_MONTHS, '3m', 3],
      [PaymentPlan.SIX_MONTHS, '6m', 6],
      [PaymentPlan.TWELVE_MONTHS, '12m', 12],
    ]

    for (const [paymentPlan, plan, termMonths] of plans) {
      const dealSchedule = generateSchedule({
        dealId: 'deal-parity',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        plan,
        installmentBasePriceNgn: annualRentNgn,
        depositPct: REVIEW_DEPOSIT_PERCENT,
      })

      const result = deriveReviewRepayment({ annualRentNgn, paymentPlan })

      expect(result.available).toBe(true)
      if (result.available) {
        // Kobo to NGN is a float division, so compare in whole kobo
        expect(Math.round(result.monthlyRepayment * 100)).toBe(dealSchedule.schedule[0].totalAmountNgn)
        expect(result.basis.termMonths).toBe(termMonths)
      }
    }
  })

  it('returns no repayment for outright applications, which have no instalments', () => {
    expect(
      deriveReviewRepayment({
        annualRentNgn: 2_400_000,
        paymentPlan: PaymentPlan.OUTRIGHT,
      }),
    ).toEqual({ available: false, reason: 'outright_plan' })
  })

  it('returns no repayment when the rent is missing or not positive', () => {
    for (const annualRentNgn of [null, undefined, 0, -5, Number.NaN]) {
      expect(
        deriveReviewRepayment({
          annualRentNgn,
          paymentPlan: PaymentPlan.SIX_MONTHS,
        }),
      ).toEqual({ available: false, reason: 'missing_rent' })
    }
  })
})
