import { addInboxItem, listInbox, setInboxStatus, getInboxStats } from '../../db.js'
import { classifyTriage, type Channel } from '../../triage-inbox.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleInbox(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // GET /api/inbox?status=open|done|all -> prioritized list + stats
  if (path === '/api/inbox' && method === 'GET') {
    const status = (url.searchParams.get('status') as 'open' | 'done' | 'all') || 'open'
    json(res, { stats: getInboxStats(), items: listInbox(status) })
    return true
  }

  // POST /api/inbox { source, text, sender?, subject?, external_id?, received_at? }
  // Classifies urgency/intent, then stores in the unified queue.
  if (path === '/api/inbox' && method === 'POST') {
    const body = await readBody(req)
    const d = JSON.parse(body.toString()) as {
      source?: Channel; text?: string; sender?: string; subject?: string; external_id?: string; received_at?: number
    }
    if (!d.source || !d.text) { json(res, { error: 'source és text kötelező' }, 400); return true }
    const c = classifyTriage(d.text, d.subject)
    const result = addInboxItem({
      source: d.source,
      external_id: d.external_id ?? null,
      sender: d.sender ?? null,
      subject: d.subject ?? null,
      preview: d.text.slice(0, 280),
      urgency: c.urgency, intent: c.intent, score: c.score,
      received_at: d.received_at,
    })
    json(res, { ...result, classification: c })
    return true
  }

  // PUT /api/inbox/:id { status: 'open'|'done' }
  const idMatch = path.match(/^\/api\/inbox\/(\d+)$/)
  if (idMatch && method === 'PUT') {
    const body = await readBody(req)
    const d = JSON.parse(body.toString()) as { status?: 'open' | 'done' }
    if (d.status !== 'open' && d.status !== 'done') { json(res, { error: "status 'open' vagy 'done'" }, 400); return true }
    if (setInboxStatus(parseInt(idMatch[1], 10), d.status)) { json(res, { ok: true }); return true }
    json(res, { error: 'nem található' }, 404)
    return true
  }

  return false
}
