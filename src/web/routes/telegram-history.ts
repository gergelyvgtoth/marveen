import { saveTelegramMessage, getTelegramHistory, reconstructThreadContext } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleTelegramHistory(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/telegram-history' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      chat_id: string
      message_id: string
      direction: 'in' | 'out'
      text: string
      user_id?: string
      ts?: number
      reply_to_message_id?: string
    }
    if (!data.chat_id || !data.message_id || !data.direction || !data.text) {
      json(res, { error: 'chat_id, message_id, direction, text required' }, 400)
      return true
    }
    if (data.direction !== 'in' && data.direction !== 'out') {
      json(res, { error: "direction must be 'in' or 'out'" }, 400)
      return true
    }
    saveTelegramMessage(data.chat_id, data.message_id, data.direction, data.text, data.user_id, data.ts, data.reply_to_message_id)
    json(res, { ok: true })
    return true
  }

  // GET /api/telegram-history/thread?chat_id=X&reply_to=Y&limit=10
  // Reconstructs the most recent meaningful content-thread so a terse inbound
  // follow-up can be anchored to real content instead of the wrong topic.
  if (path === '/api/telegram-history/thread' && method === 'GET') {
    const chatId = url.searchParams.get('chat_id')
    if (!chatId) { json(res, { error: 'chat_id required' }, 400); return true }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50)
    const replyTo = url.searchParams.get('reply_to') || undefined
    const minLen = url.searchParams.get('min_len')
    json(res, reconstructThreadContext(chatId, {
      limit,
      replyToMessageId: replyTo,
      minMeaningfulLen: minLen ? parseInt(minLen, 10) : undefined,
    }))
    return true
  }

  if (path === '/api/telegram-history' && method === 'GET') {
    const chatId = url.searchParams.get('chat_id')
    if (!chatId) { json(res, { error: 'chat_id required' }, 400); return true }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    const rows = getTelegramHistory(chatId, limit)
    json(res, rows.reverse())
    return true
  }

  return false
}
