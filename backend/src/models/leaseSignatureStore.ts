/**
 * Lease Signature store following the Hybrid pattern.
 *
 * One row per (deal, signer role). Signing is idempotent per party: a second
 * signature from the same party returns the existing record instead of
 * overwriting it (#1960).
 */

import { randomUUID } from 'node:crypto'
import { getPool, type PgPoolLike } from '../db.js'
import {
  CreateLeaseSignatureInput,
  LeaseSignature,
} from './leaseAgreement.js'

interface LeaseSignatureStorePort {
  /** Records a signature or returns the existing one for the same party. */
  create(input: CreateLeaseSignatureInput): Promise<LeaseSignature>
  findByDealAndRole(
    dealId: string,
    signerRole: 'tenant' | 'landlord',
  ): Promise<LeaseSignature | null>
  listByDealId(dealId: string): Promise<LeaseSignature[]>
  clear(): Promise<void>
}

class InMemoryLeaseSignatureStore implements LeaseSignatureStorePort {
  private signatures = new Map<string, LeaseSignature>()

  private key(dealId: string, role: string): string {
    return `${dealId}:${role}`
  }

  async create(input: CreateLeaseSignatureInput): Promise<LeaseSignature> {
    const key = this.key(input.dealId, input.signerRole)
    const existing = this.signatures.get(key)
    if (existing) return { ...existing }

    const signature: LeaseSignature = {
      signatureId: randomUUID(),
      dealId: input.dealId,
      leaseId: input.leaseId,
      signerId: input.signerId,
      signerRole: input.signerRole,
      signerName: input.signerName,
      signedAt: new Date(),
      signDate: input.signDate,
      documentHash: input.documentHash,
      ip: input.ip,
      userAgent: input.userAgent,
    }
    this.signatures.set(key, signature)
    return { ...signature }
  }

  async findByDealAndRole(
    dealId: string,
    signerRole: 'tenant' | 'landlord',
  ): Promise<LeaseSignature | null> {
    const record = this.signatures.get(this.key(dealId, signerRole))
    return record ? { ...record } : null
  }

  async listByDealId(dealId: string): Promise<LeaseSignature[]> {
    return [...this.signatures.values()]
      .filter((s) => s.dealId === dealId)
      .sort((a, b) => a.signedAt.getTime() - b.signedAt.getTime())
      .map((s) => ({ ...s }))
  }

  async clear(): Promise<void> {
    this.signatures.clear()
  }
}

type LeaseSignatureRow = {
  signature_id: string
  deal_id: string
  lease_id: string
  signer_id: string
  signer_role: 'tenant' | 'landlord'
  signer_name: string
  signed_at: Date
  sign_date: string
  document_hash: string
  ip: string | null
  user_agent: string | null
}

class PostgresLeaseSignatureStore implements LeaseSignatureStorePort {
  private async pool(): Promise<PgPoolLike> {
    const pool = await getPool()
    if (!pool) {
      throw new Error('Database pool is not available (DATABASE_URL/pg not configured)')
    }
    return pool
  }

  async isAvailable(): Promise<boolean> {
    return (await getPool()) !== null
  }

  async create(input: CreateLeaseSignatureInput): Promise<LeaseSignature> {
    const pool = await this.pool()
    const signatureId = randomUUID()
    const { rows } = await pool.query(
      `INSERT INTO lease_signatures (
         signature_id, deal_id, lease_id, signer_id, signer_role,
         signer_name, sign_date, document_hash, ip, user_agent
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (deal_id, signer_role) DO NOTHING
       RETURNING *`,
      [
        signatureId,
        input.dealId,
        input.leaseId,
        input.signerId,
        input.signerRole,
        input.signerName,
        input.signDate,
        input.documentHash,
        input.ip ?? null,
        input.userAgent ?? null,
      ],
    )

    if (rows.length > 0) {
      return this.mapRow(rows[0] as LeaseSignatureRow)
    }

    const existing = await this.findByDealAndRole(input.dealId, input.signerRole)
    if (!existing) throw new Error('Failed to record signature')
    return existing
  }

  async findByDealAndRole(
    dealId: string,
    signerRole: 'tenant' | 'landlord',
  ): Promise<LeaseSignature | null> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      'SELECT * FROM lease_signatures WHERE deal_id = $1 AND signer_role = $2',
      [dealId, signerRole],
    )
    if (rows.length === 0) return null
    return this.mapRow(rows[0] as LeaseSignatureRow)
  }

  async listByDealId(dealId: string): Promise<LeaseSignature[]> {
    const pool = await this.pool()
    const { rows } = await pool.query(
      'SELECT * FROM lease_signatures WHERE deal_id = $1 ORDER BY signed_at ASC',
      [dealId],
    )
    return rows.map((r) => this.mapRow(r as LeaseSignatureRow))
  }

  async clear(): Promise<void> {
    const pool = await this.pool()
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('leaseSignatureStore.clear() is only supported in test env')
    }
    await pool.query('TRUNCATE lease_signatures RESTART IDENTITY CASCADE')
  }

  private mapRow(row: LeaseSignatureRow): LeaseSignature {
    return {
      signatureId: row.signature_id,
      dealId: row.deal_id,
      leaseId: row.lease_id,
      signerId: row.signer_id,
      signerRole: row.signer_role,
      signerName: row.signer_name,
      signedAt: new Date(row.signed_at),
      signDate: row.sign_date,
      documentHash: row.document_hash,
      ip: row.ip ?? undefined,
      userAgent: row.user_agent ?? undefined,
    }
  }
}

class HybridLeaseSignatureStore implements LeaseSignatureStorePort {
  private memory = new InMemoryLeaseSignatureStore()
  private postgres = new PostgresLeaseSignatureStore()

  private async adapter(): Promise<LeaseSignatureStorePort> {
    if (await this.postgres.isAvailable()) {
      return this.postgres
    }
    return this.memory
  }

  async create(input: CreateLeaseSignatureInput): Promise<LeaseSignature> {
    return (await this.adapter()).create(input)
  }

  async findByDealAndRole(
    dealId: string,
    signerRole: 'tenant' | 'landlord',
  ): Promise<LeaseSignature | null> {
    return (await this.adapter()).findByDealAndRole(dealId, signerRole)
  }

  async listByDealId(dealId: string): Promise<LeaseSignature[]> {
    return (await this.adapter()).listByDealId(dealId)
  }

  async clear(): Promise<void> {
    return (await this.adapter()).clear()
  }
}

export const leaseSignatureStore = new HybridLeaseSignatureStore()
