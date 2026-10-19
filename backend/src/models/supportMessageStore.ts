import { v4 as uuidv4 } from 'uuid'
import { getPool } from '../db.js'
import type { SupportMessage, ListSupportMessagesResult } from '../schemas/supportMessage.js'

export interface CreateSupportMessageData {
  name: string
  email: string
  phone: string | null
  subject: string
  message: string
  ip: string | null
  userAgent: string | null
}

export interface SupportMessageStore {
  create(data: CreateSupportMessageData): Promise<SupportMessage>
  list(page: number, pageSize: number): Promise<ListSupportMessagesResult>
}

export class InMemorySupportMessageStore implements SupportMessageStore {
  private messages: SupportMessage[] = []

  async create(data: CreateSupportMessageData): Promise<SupportMessage> {
    const message: SupportMessage = {
      messageId: uuidv4(),
      ...data,
      createdAt: new Date(),
    }
    this.messages.push(message)
    return message
  }

  async list(page: number, pageSize: number): Promise<ListSupportMessagesResult> {
    const sorted = [...this.messages].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )
    const total = sorted.length
    const start = (page - 1) * pageSize
    const messages = sorted.slice(start, start + pageSize)
    const totalPages = Math.ceil(total / pageSize)

    return { messages, total, page, pageSize, totalPages }
  }

  async clear(): Promise<void> {
    this.messages = []
  }
}

export class PostgresSupportMessageStore implements SupportMessageStore {
  async create(data: CreateSupportMessageData): Promise<SupportMessage> {
    const pool = await getPool()
    if (!pool) {
      throw new Error('Database pool not available')
    }

    const result = await pool.query(
      `INSERT INTO support_messages (name, email, phone, subject, message, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING message_id, name, email, phone, subject, message, ip, user_agent, created_at`,
      [
        data.name,
        data.email,
        data.phone,
        data.subject,
        data.message,
        data.ip,
        data.userAgent,
      ],
    )

    if (result.rows.length === 0) {
      throw new Error('Failed to create support message')
    }

    return this.mapRow(result.rows[0])
  }

  async list(page: number, pageSize: number): Promise<ListSupportMessagesResult> {
    const pool = await getPool()
    if (!pool) {
      throw new Error('Database pool not available')
    }

    const offset = (page - 1) * pageSize

    const countResult = await pool.query('SELECT COUNT(*) FROM support_messages')
    const total = parseInt(countResult.rows[0].count, 10)

    const result = await pool.query(
      `SELECT message_id, name, email, phone, subject, message, ip, user_agent, created_at
       FROM support_messages
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    )

    const messages = result.rows.map((row) => this.mapRow(row))
    const totalPages = Math.ceil(total / pageSize)

    return { messages, total, page, pageSize, totalPages }
  }

  private mapRow(row: any): SupportMessage {
    return {
      messageId: row.message_id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      subject: row.subject,
      message: row.message,
      ip: row.ip,
      userAgent: row.user_agent,
      createdAt: new Date(row.created_at),
    }
  }
}

let supportMessageStore: SupportMessageStore

export function initSupportMessageStore(): SupportMessageStore {
  if (!supportMessageStore) {
    if (process.env.NODE_ENV === 'test') {
      supportMessageStore = new InMemorySupportMessageStore()
    } else {
      supportMessageStore = new PostgresSupportMessageStore()
    }
  }
  return supportMessageStore
}

export function getSupportMessageStore(): SupportMessageStore {
  if (!supportMessageStore) {
    return initSupportMessageStore()
  }
  return supportMessageStore
}
