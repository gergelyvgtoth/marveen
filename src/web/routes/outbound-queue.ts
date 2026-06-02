import {
  enqueueOutbound,
  listOutbound,
  markOutboundSent,
  markOutboundFailed,
  getOutboundQueueStats,
} from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Outbound resend queue: the agent enqueues a send that failed because the
// Telegram MCP pipe was down; the channel-health-monitor re-injects pending
// rows after reconnect so they get resent. See src/web/channel-health-monitor.ts
// and src/web/outbound-resend.ts.
export async function tryHandleOutboundQueue(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // GET /api/outbound-queue?status=pending|sent|failed -> list + stats
  if (path === '/api/outbound-queue' && method === 'GET') {
    const status = url.searchParams.get('status') as 'pending' | 'sent' | 'failed' | null
    json(res, { stats: getOutboundQueueStats(), items: listOutbound(status ?? undefined) })
    return true
  }

  // POST /api/outbound-queue { agent_id, chat_id, text, reply_to_message_id?, error? }
  if (path === '/api/outbound-queue' && method === 'POST') {
    const body = await readBody(req)
    const d = JSON.parse(body.toString()) as {
      agent_id?: string; chat_id?: string; text?: string; reply_to_message_id?: string; error?: string
    }
    if (!d.agent_id || !d.chat_id || !d.text) {
      json(res, { error: 'agent_id, chat_id, text kötelező' }, 400)
      return true
    }
    const id = enqueueOutbound({
      agentId: d.agent_id, chatId: d.chat_id, text: d.text,
      replyToMessageId: d.reply_to_message_id ?? null, error: d.error ?? null,
    })
    json(res, { ok: true, id })
    return true
  }

  // PUT /api/outbound-queue/:id { status: 'sent'|'failed', error? }
  const idMatch = path.match(/^\/api\/outbound-queue\/(\d+)$/)
  if (idMatch && method === 'PUT') {
    const body = await readBody(req)
    const d = JSON.parse(body.toString()) as { status?: 'sent' | 'failed'; error?: string }
    const id = parseInt(idMatch[1], 10)
    if (d.status === 'sent') {
      if (markOutboundSent(id)) { json(res, { ok: true }); return true }
    } else if (d.status === 'failed') {
      if (markOutboundFailed(id, d.error)) { json(res, { ok: true }); return true }
    } else {
      json(res, { error: "status 'sent' vagy 'failed'" }, 400)
      return true
    }
    json(res, { error: 'nem található' }, 404)
    return true
  }

  return false
}
