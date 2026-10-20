import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ListingStatus, type CreateListingInput } from '../models/listing.js'
import { listingStore } from '../models/listingStore.js'

describe('Public Properties API (issue #1956)', () => {
  const app = createApp()
  let sequence = 0

  beforeEach(async () => {
    sequence = 0
    await listingStore.clear()
  })

  async function createListing(
    input: Partial<CreateListingInput> = {},
    status: ListingStatus.APPROVED | ListingStatus.PENDING_REVIEW = ListingStatus.APPROVED,
  ) {
    sequence += 1
    const listing = await listingStore.create({
      whistleblowerId: input.whistleblowerId ?? `wb-${sequence}`,
      address: input.address ?? `${sequence} Test Street`,
      city: input.city ?? 'Lagos',
      area: input.area ?? 'Lekki',
      bedrooms: input.bedrooms ?? 2,
      bathrooms: input.bathrooms ?? 2,
      annualRentNgn: input.annualRentNgn ?? 2_500_000,
      outrightPriceNgn: input.outrightPriceNgn,
      installmentBasePriceNgn: input.installmentBasePriceNgn,
      negotiatedLandlordRateNgn: input.negotiatedLandlordRateNgn,
      description: input.description ?? 'Bright apartment',
      photos: input.photos ?? [
        'https://example.com/photo-1.jpg',
        'https://example.com/photo-2.jpg',
        'https://example.com/photo-3.jpg',
      ],
    })

    if (status === ListingStatus.APPROVED) {
      const approved = await listingStore.moderate(
        listing.listingId,
        ListingStatus.APPROVED,
        'properties-test-admin',
      )
      if (!approved) throw new Error('Expected listing to be approved')
      return approved
    }
    return listing
  }

  it('returns the PropertySearchResponse envelope with approved properties only', async () => {
    await createListing({ address: '1 Approved Road' })
    await createListing({ address: '2 Pending Road' }, ListingStatus.PENDING_REVIEW)

    const response = await request(app).get('/api/properties/search').expect(200)

    expect(response.body).toMatchObject({ success: true, total: 1, page: 1, pageSize: 20, totalPages: 1 })
    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0]).toMatchObject({
      address: '1 Approved Road',
      hasApprovedInspection: false,
      status: ListingStatus.APPROVED,
    })
    expect(response.body.data[0]).not.toHaveProperty('highlightedSnippet')
    expect(response.body.data[0]).not.toHaveProperty('rank')
  })

  it('applies city, bedroom, bathroom and annual rent range filters from the frontend', async () => {
    await createListing({ address: 'Match', city: 'Lagos', bedrooms: 3, bathrooms: 2, annualRentNgn: 3_000_000 })
    await createListing({ address: 'Wrong city', city: 'Abuja', bedrooms: 3, bathrooms: 2, annualRentNgn: 3_000_000 })
    await createListing({ address: 'Too small', city: 'Lagos', bedrooms: 1, bathrooms: 2, annualRentNgn: 3_000_000 })
    await createListing({ address: 'Too many baths', city: 'Lagos', bedrooms: 3, bathrooms: 5, annualRentNgn: 3_000_000 })
    await createListing({ address: 'Too expensive', city: 'Lagos', bedrooms: 3, bathrooms: 2, annualRentNgn: 9_000_000 })

    const response = await request(app)
      .get('/api/properties/search')
      .query({
        city: 'lagos',
        minBedrooms: 2,
        maxBedrooms: 4,
        minBathrooms: 1,
        maxBathrooms: 3,
        maxAnnualRent: 5_000_000,
      })
      .expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data[0].address).toBe('Match')
  })

  it('sorts by price when sortBy is given', async () => {
    await createListing({ address: 'Mid', annualRentNgn: 2_000_000 })
    await createListing({ address: 'Cheap', annualRentNgn: 1_000_000 })
    await createListing({ address: 'Dear', annualRentNgn: 3_000_000 })

    const ascending = await request(app).get('/api/properties/search').query({ sortBy: 'price_asc' }).expect(200)
    expect(ascending.body.data.map((p: { address: string }) => p.address)).toEqual(['Cheap', 'Mid', 'Dear'])

    const descending = await request(app).get('/api/properties/search').query({ sortBy: 'price_desc' }).expect(200)
    expect(descending.body.data.map((p: { address: string }) => p.address)).toEqual(['Dear', 'Mid', 'Cheap'])
  })

  it('paginates search results', async () => {
    for (let i = 0; i < 3; i += 1) {
      await createListing({ annualRentNgn: 1_000_000 + i })
    }

    const response = await request(app)
      .get('/api/properties/search')
      .query({ page: 2, pageSize: 2 })
      .expect(200)

    expect(response.body).toMatchObject({ total: 3, page: 2, pageSize: 2, totalPages: 2 })
    expect(response.body.data).toHaveLength(1)
  })

  it('returns the PropertyDetailResponse for an approved property and 404 otherwise', async () => {
    const approved = await createListing({ address: 'Detail Road', description: 'Detail' })
    const pending = await createListing({ address: 'Hidden Road' }, ListingStatus.PENDING_REVIEW)

    const detail = await request(app).get(`/api/properties/${approved.listingId}`).expect(200)
    expect(detail.body).toMatchObject({
      success: true,
      data: { listingId: approved.listingId, address: 'Detail Road', photos: approved.photos },
    })

    await request(app).get(`/api/properties/${pending.listingId}`).expect(404)
    await request(app).get('/api/properties/does-not-exist').expect(404)
  })

  it('looks up requested listingIds, keeping only approved ones', async () => {
    const first = await createListing({ address: 'First' })
    const second = await createListing({ address: 'Second' })
    const pending = await createListing({ address: 'Pending' }, ListingStatus.PENDING_REVIEW)

    const response = await request(app)
      .get('/api/properties')
      .query({ listingIds: `${first.listingId},${pending.listingId},missing-id,${second.listingId}` })
      .expect(200)

    expect(response.body.total).toBe(2)
    expect(response.body.data.map((p: { listingId: string }) => p.listingId)).toEqual([
      first.listingId,
      second.listingId,
    ])
  })

  it('rejects lookups with more than 50 listingIds', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `listing-${i}`).join(',')

    await request(app).get('/api/properties').query({ listingIds: ids }).expect(400)
  })
})
