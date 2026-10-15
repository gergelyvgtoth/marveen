import { saveTelegramMessage, getTelegramHistory } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// /api/telegram-history: the agent-side Telegram log the CLAUDE.md recipe writes
// after every inbound/outbound message. The route lived only on the old
// gergely-dev branch and never reached main, so since the switch every POST
// returned 404 and the table stopped at 2026-07-09 (962 rows) while the db
// helpers stayed. Ported without the gergely-dev thread-reconstruction extra,
// whose db side (reply_to_message_id, reconstructThreadContext) is not here.
export async function tryHandleTelegramHistory(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/telegram-history' && method === 'POST') {
    const body = await readBody(req)
    let data: {
      chat_id?: unknown
      message_id?: unknown
      direction?: unknown
      text?: unknown
      user_id?: unknown
      ts?: unknown
    }
    try {
      data = JSON.parse(body.toString())
    } catch {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    if (!data.chat_id || !data.message_id || !data.direction || !data.text) {
      json(res, { error: 'chat_id, message_id, direction, text required' }, 400)
      return true
    }
    if (data.direction !== 'in' && data.direction !== 'out') {
      json(res, { error: "direction must be 'in' or 'out'" }, 400)
      return true
    }
    saveTelegramMessage(
      String(data.chat_id),
      String(data.message_id),
      data.direction,
      String(data.text),
      data.user_id != null ? String(data.user_id) : undefined,
      typeof data.ts === 'number' ? data.ts : undefined,
    )
    json(res, { ok: true })
    return true
  }

  if (path === '/api/telegram-history' && method === 'GET') {
    const chatId = url.searchParams.get('chat_id')
    if (!chatId) { json(res, { error: 'chat_id required' }, 400); return true }
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200)
    // Oldest first, as the CLAUDE.md recipe promises.
    json(res, getTelegramHistory(chatId, limit).reverse())
    return true
  }

  return false
}
