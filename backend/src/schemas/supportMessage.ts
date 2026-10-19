import { z } from 'zod'

export const createSupportMessageSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255, 'Name must be at most 255 characters'),
  email: z.string().email('Invalid email address'),
  phone: z.string().max(20, 'Phone must be at most 20 characters').optional().nullable(),
  subject: z.string().min(1, 'Subject is required').max(255, 'Subject must be at most 255 characters'),
  message: z.string().min(1, 'Message is required').max(5000, 'Message must be at most 5000 characters'),
})

export type CreateSupportMessageRequest = z.infer<typeof createSupportMessageSchema>

export interface SupportMessage {
  messageId: string
  name: string
  email: string
  phone: string | null
  subject: string
  message: string
  ip: string | null
  userAgent: string | null
  createdAt: Date
}

export interface ListSupportMessagesResult {
  messages: SupportMessage[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}
