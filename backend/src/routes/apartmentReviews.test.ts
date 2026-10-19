import { describe, it, expect, beforeEach } from 'vitest'
import { getApartmentReviewStore } from '../models/apartmentReviewStore.js'

describe('Apartment Reviews Store', () => {
  let store: ReturnType<typeof getApartmentReviewStore>

  beforeEach(() => {
    store = getApartmentReviewStore()
    if ('clear' in store) {
      ;(store as any).clear()
    }
  })

  describe('create', () => {
    it('should create a review', async () => {
      const review = await store.create({
        apartmentId: '550e8400-e29b-41d4-a716-446655440000',
        userId: '660e8400-e29b-41d4-a716-446655440000',
        rating: 4,
        content: 'Great apartment!',
        verifiedStay: true,
      })

      expect(review.id).toBeDefined()
      expect(review.apartmentId).toBe('550e8400-e29b-41d4-a716-446655440000')
      expect(review.rating).toBe(4)
      expect(review.content).toBe('Great apartment!')
      expect(review.verifiedStay).toBe(true)
      expect(review.isHidden).toBe(false)
      expect(review.isReported).toBe(false)
      expect(review.helpfulCount).toBe(0)
    })
  })

  describe('findByUserAndApartment', () => {
    it('should find existing review', async () => {
      const userId = '660e8400-e29b-41d4-a716-446655440000'
      const apartmentId = '550e8400-e29b-41d4-a716-446655440000'

      await store.create({
        apartmentId,
        userId,
        rating: 5,
        content: 'Excellent!',
        verifiedStay: true,
      })

      const found = await store.findByUserAndApartment(userId, apartmentId)
      expect(found).toBeDefined()
      expect(found?.rating).toBe(5)
    })

    it('should return null for non-existent review', async () => {
      const found = await store.findByUserAndApartment(
        '660e8400-e29b-41d4-a716-446655440000',
        '550e8400-e29b-41d4-a716-446655440000',
      )
      expect(found).toBeNull()
    })
  })

  describe('list', () => {
    it('should list reviews for apartment', async () => {
      const apartmentId = '550e8400-e29b-41d4-a716-446655440000'

      await store.create({
        apartmentId,
        userId: '660e8400-e29b-41d4-a716-446655440000',
        rating: 5,
        content: 'Great!',
        verifiedStay: true,
      })

      await store.create({
        apartmentId,
        userId: '770e8400-e29b-41d4-a716-446655440000',
        rating: 4,
        content: 'Good',
        verifiedStay: false,
      })

      const result = await store.list({ apartmentId }, 1, 10)
      expect(result.reviews.length).toBe(2)
      expect(result.total).toBe(2)
      expect(result.aggregateRating).toBe(4.5)
    })

    it('should filter by rating', async () => {
      const apartmentId = '550e8400-e29b-41d4-a716-446655440000'

      await store.create({
        apartmentId,
        userId: '660e8400-e29b-41d4-a716-446655440000',
        rating: 5,
        content: 'Excellent',
        verifiedStay: true,
      })

      await store.create({
        apartmentId,
        userId: '770e8400-e29b-41d4-a716-446655440000',
        rating: 3,
        content: 'Average',
        verifiedStay: false,
      })

      const result = await store.list({ apartmentId, rating: 5 }, 1, 10)
      expect(result.reviews.length).toBe(1)
      expect(result.reviews[0].rating).toBe(5)
    })

    it('should filter by verified stay', async () => {
      const apartmentId = '550e8400-e29b-41d4-a716-446655440000'

      await store.create({
        apartmentId,
        userId: '660e8400-e29b-41d4-a716-446655440000',
        rating: 5,
        content: 'Verified',
        verifiedStay: true,
      })

      await store.create({
        apartmentId,
        userId: '770e8400-e29b-41d4-a716-446655440000',
        rating: 4,
        content: 'Not verified',
        verifiedStay: false,
      })

      const result = await store.list({ apartmentId, verifiedStay: true }, 1, 10)
      expect(result.reviews.length).toBe(1)
      expect(result.reviews[0].verifiedStay).toBe(true)
    })

    it('should sort by newest', async () => {
      const apartmentId = '550e8400-e29b-41d4-a716-446655440000'

      const review1 = await store.create({
        apartmentId,
        userId: '660e8400-e29b-41d4-a716-446655440000',
        rating: 5,
        content: 'First',
        verifiedStay: true,
      })

      await new Promise((resolve) => setTimeout(resolve, 10))

      const review2 = await store.create({
        apartmentId,
        userId: '770e8400-e29b-41d4-a716-446655440000',
        rating: 4,
        content: 'Second',
        verifiedStay: false,
      })

      const result = await store.list({ apartmentId, sortBy: 'newest' }, 1, 10)
      expect(result.reviews[0].id).toBe(review2.id)
      expect(result.reviews[1].id).toBe(review1.id)
    })

    it('should sort by rating descending', async () => {
      const apartmentId = '550e8400-e29b-41d4-a716-446655440000'

      await store.create({
        apartmentId,
        userId: '660e8400-e29b-41d4-a716-446655440000',
        rating: 3,
        content: 'Three',
        verifiedStay: true,
      })

      await store.create({
        apartmentId,
        userId: '770e8400-e29b-41d4-a716-446655440000',
        rating: 5,
        content: 'Five',
        verifiedStay: false,
      })

      const result = await store.list({ apartmentId, sortBy: 'rating_desc' }, 1, 10)
      expect(result.reviews[0].rating).toBe(5)
      expect(result.reviews[1].rating).toBe(3)
    })

    it('should exclude hidden reviews', async () => {
      const apartmentId = '550e8400-e29b-41d4-a716-446655440000'

      const review1 = await store.create({
        apartmentId,
        userId: '660e8400-e29b-41d4-a716-446655440000',
        rating: 5,
        content: 'Visible',
        verifiedStay: true,
      })

      const review2 = await store.create({
        apartmentId,
        userId: '770e8400-e29b-41d4-a716-446655440000',
        rating: 4,
        content: 'Hidden',
        verifiedStay: false,
      })

      await store.setHidden(review2.id, true)

      const result = await store.list({ apartmentId }, 1, 10)
      expect(result.reviews.length).toBe(1)
      expect(result.reviews[0].id).toBe(review1.id)
    })

    it('should calculate aggregate rating excluding hidden', async () => {
      const apartmentId = '550e8400-e29b-41d4-a716-446655440000'

      const review1 = await store.create({
        apartmentId,
        userId: '660e8400-e29b-41d4-a716-446655440000',
        rating: 5,
        content: 'Five',
        verifiedStay: true,
      })

      const review2 = await store.create({
        apartmentId,
        userId: '770e8400-e29b-41d4-a716-446655440000',
        rating: 1,
        content: 'One',
        verifiedStay: false,
      })

      await store.setHidden(review2.id, true)

      const result = await store.list({ apartmentId }, 1, 10)
      expect(result.aggregateRating).toBe(5) // Only review1 is visible
    })

    it('should paginate results', async () => {
      const apartmentId = '550e8400-e29b-41d4-a716-446655440000'

      for (let i = 1; i <= 5; i++) {
        await store.create({
          apartmentId,
          userId: `user-${i}00e8400-e29b-41d4-a716-446655440000`,
          rating: 5,
          content: `Review ${i}`,
          verifiedStay: true,
        })
      }

      const page1 = await store.list({ apartmentId }, 1, 2)
      expect(page1.reviews.length).toBe(2)
      expect(page1.page).toBe(1)
      expect(page1.pageSize).toBe(2)
      expect(page1.total).toBe(5)
      expect(page1.totalPages).toBe(3)

      const page2 = await store.list({ apartmentId }, 2, 2)
      expect(page2.reviews.length).toBe(2)
      expect(page2.page).toBe(2)
    })
  })

  describe('markReported', () => {
    it('should mark review as reported', async () => {
      const review = await store.create({
        apartmentId: '550e8400-e29b-41d4-a716-446655440000',
        userId: '660e8400-e29b-41d4-a716-446655440000',
        rating: 4,
        content: 'Test',
        verifiedStay: true,
      })

      await store.markReported(review.id)

      const found = await store.findById(review.id)
      expect(found?.isReported).toBe(true)
    })
  })

  describe('setHidden', () => {
    it('should hide and unhide reviews', async () => {
      const review = await store.create({
        apartmentId: '550e8400-e29b-41d4-a716-446655440000',
        userId: '660e8400-e29b-41d4-a716-446655440000',
        rating: 4,
        content: 'Test',
        verifiedStay: true,
      })

      await store.setHidden(review.id, true)
      let found = await store.findById(review.id)
      expect(found?.isHidden).toBe(true)

      await store.setHidden(review.id, false)
      found = await store.findById(review.id)
      expect(found?.isHidden).toBe(false)
    })
  })

  describe('incrementHelpful', () => {
    it('should increment helpful count', async () => {
      const review = await store.create({
        apartmentId: '550e8400-e29b-41d4-a716-446655440000',
        userId: '660e8400-e29b-41d4-a716-446655440000',
        rating: 4,
        content: 'Test',
        verifiedStay: true,
      })

      expect(review.helpfulCount).toBe(0)

      await store.incrementHelpful(review.id)
      let found = await store.findById(review.id)
      expect(found?.helpfulCount).toBe(1)

      await store.incrementHelpful(review.id)
      found = await store.findById(review.id)
      expect(found?.helpfulCount).toBe(2)
    })
  })
})
