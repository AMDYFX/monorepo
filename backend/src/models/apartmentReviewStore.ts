import { v4 as uuidv4 } from 'uuid'
import { getPool } from '../db.js'
import type { ApartmentReview, ApartmentReviewsListResult, ListApartmentReviewsFilters } from '../schemas/apartmentReview.js'

export interface CreateApartmentReviewData {
  apartmentId: string
  userId: string
  rating: number
  content: string
  verifiedStay: boolean
}

export interface ApartmentReviewStore {
  create(data: CreateApartmentReviewData): Promise<ApartmentReview>
  findById(id: string): Promise<ApartmentReview | null>
  findByUserAndApartment(userId: string, apartmentId: string): Promise<ApartmentReview | null>
  list(filters: ListApartmentReviewsFilters, page: number, pageSize: number): Promise<ApartmentReviewsListResult>
  markReported(id: string): Promise<void>
  setHidden(id: string, isHidden: boolean): Promise<void>
  incrementHelpful(id: string): Promise<void>
}

export class InMemoryApartmentReviewStore implements ApartmentReviewStore {
  private reviews: ApartmentReview[] = []

  async create(data: CreateApartmentReviewData): Promise<ApartmentReview> {
    const review: ApartmentReview = {
      id: uuidv4(),
      ...data,
      isHidden: false,
      isReported: false,
      helpfulCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.reviews.push(review)
    return review
  }

  async findById(id: string): Promise<ApartmentReview | null> {
    return this.reviews.find((r) => r.id === id) ?? null
  }

  async findByUserAndApartment(userId: string, apartmentId: string): Promise<ApartmentReview | null> {
    return this.reviews.find((r) => r.userId === userId && r.apartmentId === apartmentId) ?? null
  }

  async list(filters: ListApartmentReviewsFilters, page: number, pageSize: number): Promise<ApartmentReviewsListResult> {
    let filtered = this.reviews.filter((r) => !r.isHidden)

    if (filters.apartmentId) {
      filtered = filtered.filter((r) => r.apartmentId === filters.apartmentId)
    }
    if (filters.rating) {
      filtered = filtered.filter((r) => r.rating === filters.rating)
    }
    if (filters.verifiedStay) {
      filtered = filtered.filter((r) => r.verifiedStay)
    }

    // Sort
    const sorted = [...filtered]
    if (filters.sortBy === 'newest') {
      sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    } else if (filters.sortBy === 'oldest') {
      sorted.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    } else if (filters.sortBy === 'rating_desc') {
      sorted.sort((a, b) => b.rating - a.rating)
    } else if (filters.sortBy === 'rating_asc') {
      sorted.sort((a, b) => a.rating - b.rating)
    }

    const total = sorted.length
    const start = (page - 1) * pageSize
    const reviews = sorted.slice(start, start + pageSize)
    const totalPages = Math.ceil(total / pageSize)

    const aggregateRating = filtered.length > 0 ? filtered.reduce((sum, r) => sum + r.rating, 0) / filtered.length : null

    return { reviews, total, page, pageSize, totalPages, aggregateRating }
  }

  async markReported(id: string): Promise<void> {
    const review = this.reviews.find((r) => r.id === id)
    if (review) {
      review.isReported = true
      review.updatedAt = new Date()
    }
  }

  async setHidden(id: string, isHidden: boolean): Promise<void> {
    const review = this.reviews.find((r) => r.id === id)
    if (review) {
      review.isHidden = isHidden
      review.updatedAt = new Date()
    }
  }

  async incrementHelpful(id: string): Promise<void> {
    const review = this.reviews.find((r) => r.id === id)
    if (review) {
      review.helpfulCount++
      review.updatedAt = new Date()
    }
  }

  async clear(): Promise<void> {
    this.reviews = []
  }
}

export class PostgresApartmentReviewStore implements ApartmentReviewStore {
  async create(data: CreateApartmentReviewData): Promise<ApartmentReview> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not available')

    const result = await pool.query(
      `INSERT INTO apartment_reviews (apartment_id, user_id, rating, content, verified_stay)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, apartment_id, user_id, rating, content, verified_stay, is_hidden, is_reported, helpful_count, created_at, updated_at`,
      [data.apartmentId, data.userId, data.rating, data.content, data.verifiedStay],
    )

    if (result.rows.length === 0) throw new Error('Failed to create review')
    return this.mapRow(result.rows[0])
  }

  async findById(id: string): Promise<ApartmentReview | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not available')

    const result = await pool.query(
      `SELECT ar.id, ar.apartment_id, ar.user_id, u.name as user_name, ar.rating, ar.content, 
              ar.verified_stay, ar.is_hidden, ar.is_reported, ar.helpful_count, ar.created_at, ar.updated_at
       FROM apartment_reviews ar
       LEFT JOIN users u ON ar.user_id = u.id
       WHERE ar.id = $1`,
      [id],
    )

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null
  }

  async findByUserAndApartment(userId: string, apartmentId: string): Promise<ApartmentReview | null> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not available')

    const result = await pool.query(
      `SELECT ar.id, ar.apartment_id, ar.user_id, u.name as user_name, ar.rating, ar.content, 
              ar.verified_stay, ar.is_hidden, ar.is_reported, ar.helpful_count, ar.created_at, ar.updated_at
       FROM apartment_reviews ar
       LEFT JOIN users u ON ar.user_id = u.id
       WHERE ar.user_id = $1 AND ar.apartment_id = $2`,
      [userId, apartmentId],
    )

    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null
  }

  async list(filters: ListApartmentReviewsFilters, page: number, pageSize: number): Promise<ApartmentReviewsListResult> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not available')

    const conditions: string[] = ['ar.is_hidden = false']
    const params: any[] = []

    if (filters.apartmentId) {
      conditions.push(`ar.apartment_id = $${params.length + 1}`)
      params.push(filters.apartmentId)
    }
    if (filters.rating) {
      conditions.push(`ar.rating = $${params.length + 1}`)
      params.push(filters.rating)
    }
    if (filters.verifiedStay) {
      conditions.push(`ar.verified_stay = true`)
    }

    const whereClause = conditions.join(' AND ')

    // Count total
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM apartment_reviews ar WHERE ${whereClause}`,
      params,
    )
    const total = parseInt(countResult.rows[0].count, 10)

    // Determine sort
    let orderBy = 'ar.created_at DESC'
    if (filters.sortBy === 'oldest') orderBy = 'ar.created_at ASC'
    else if (filters.sortBy === 'rating_desc') orderBy = 'ar.rating DESC'
    else if (filters.sortBy === 'rating_asc') orderBy = 'ar.rating ASC'

    const offset = (page - 1) * pageSize

    const result = await pool.query(
      `SELECT ar.id, ar.apartment_id, ar.user_id, u.name as user_name, ar.rating, ar.content, 
              ar.verified_stay, ar.is_hidden, ar.is_reported, ar.helpful_count, ar.created_at, ar.updated_at
       FROM apartment_reviews ar
       LEFT JOIN users u ON ar.user_id = u.id
       WHERE ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    )

    const reviews = result.rows.map((row) => this.mapRow(row))
    const totalPages = Math.ceil(total / pageSize)

    // Calculate aggregate rating for visible reviews
    const aggResult = await pool.query(
      `SELECT AVG(rating) as avg_rating FROM apartment_reviews ar WHERE ${whereClause}`,
      params,
    )
    const aggregateRating = aggResult.rows[0].avg_rating ? parseFloat(aggResult.rows[0].avg_rating) : null

    return { reviews, total, page, pageSize, totalPages, aggregateRating }
  }

  async markReported(id: string): Promise<void> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not available')

    await pool.query(`UPDATE apartment_reviews SET is_reported = true, updated_at = NOW() WHERE id = $1`, [id])
  }

  async setHidden(id: string, isHidden: boolean): Promise<void> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not available')

    await pool.query(`UPDATE apartment_reviews SET is_hidden = $1, updated_at = NOW() WHERE id = $2`, [isHidden, id])
  }

  async incrementHelpful(id: string): Promise<void> {
    const pool = await getPool()
    if (!pool) throw new Error('Database pool not available')

    await pool.query(`UPDATE apartment_reviews SET helpful_count = helpful_count + 1, updated_at = NOW() WHERE id = $1`, [id])
  }

  private mapRow(row: any): ApartmentReview {
    return {
      id: row.id,
      apartmentId: row.apartment_id,
      userId: row.user_id,
      userName: row.user_name,
      rating: row.rating,
      content: row.content,
      verifiedStay: row.verified_stay,
      isHidden: row.is_hidden,
      isReported: row.is_reported,
      helpfulCount: row.helpful_count,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }
  }
}

let apartmentReviewStore: ApartmentReviewStore

export function initApartmentReviewStore(): ApartmentReviewStore {
  if (!apartmentReviewStore) {
    if (process.env.NODE_ENV === 'test') {
      apartmentReviewStore = new InMemoryApartmentReviewStore()
    } else {
      apartmentReviewStore = new PostgresApartmentReviewStore()
    }
  }
  return apartmentReviewStore
}

export function getApartmentReviewStore(): ApartmentReviewStore {
  if (!apartmentReviewStore) {
    return initApartmentReviewStore()
  }
  return apartmentReviewStore
}
