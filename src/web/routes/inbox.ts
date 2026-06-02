import { addInboxItem, listInbox, setInboxStatus, getInboxStats, getInboxSlaBreaches, getUnansweredInboundTelegram } from '../../db.js'
import { classifyTriage, type Channel } from '../../triage-inbox.js'
import { syncEmailsToInbox, gmailFetcher } from '../../email-connector.js'
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

  // POST /api/inbox/sync-telegram { since_days? }
  // Auto-ingest: pulls UNANSWERED inbound Telegram messages (no outbound reply
  // after them) from telegram_history into the inbox, classified. Dedup via
  // external_id = tg-<message_id>. This is what actually feeds the triage queue.
  if (path === '/api/inbox/sync-telegram' && method === 'POST') {
    const body = await readBody(req).catch(() => Buffer.from('{}'))
    let d: { since_days?: number } = {}
    try { d = JSON.parse(body.toString() || '{}') } catch { /* defaults */ }
    const sinceDays = d.since_days ?? 3
    const since = Math.floor(Date.now() / 1000) - sinceDays * 86400
    const rows = getUnansweredInboundTelegram(since)
    let added = 0, skipped = 0
    for (const r of rows) {
      const c = classifyTriage(r.text)
      const res = addInboxItem({
        source: 'telegram', external_id: `tg-${r.message_id}`,
        sender: r.user_id, preview: r.text.slice(0, 280),
        urgency: c.urgency, intent: c.intent, score: c.score, received_at: r.ts,
      })
      if (res.deduped) skipped++; else added++
    }
    json(res, { added, skipped, scanned: rows.length })
    return true
  }

  // POST /api/inbox/sync-email { since_days? }
  // Backend email -> inbox connector: pulls recent emails directly (no agent /
  // MCP needed), classifies + dedups via external_id = email-<id>, so the
  // unified queue is genuinely multi-channel. Returns { configured: false }
  // when no email transport is set up yet (so "no creds" != "no new mail").
  if (path === '/api/inbox/sync-email' && method === 'POST') {
    const body = await readBody(req).catch(() => Buffer.from('{}'))
    let d: { since_days?: number } = {}
    try { d = JSON.parse(body.toString() || '{}') } catch { /* defaults */ }
    const sinceDays = d.since_days ?? 1
    const sinceTs = Math.floor(Date.now() / 1000) - sinceDays * 86400
    try {
      const result = await syncEmailsToInbox(gmailFetcher, { sinceTs })
      json(res, result)
    } catch (err) {
      json(res, { configured: gmailFetcher.configured(), added: 0, skipped: 0, scanned: 0, error: String(err) }, 502)
    }
    return true
  }

  // GET /api/inbox/sla-breaches?threshold=1800&claim=true
  // Urgent items open past the threshold. claim=true stamps them so the
  // heartbeat nudges each only once. Used by the SLA escalation heartbeat.
  if (path === '/api/inbox/sla-breaches' && method === 'GET') {
    const threshold = parseInt(url.searchParams.get('threshold') || '1800', 10)
    const claim = url.searchParams.get('claim') === 'true'
    const nowTs = Math.floor(Date.now() / 1000)
    const breaches = getInboxSlaBreaches(nowTs, threshold, claim)
    json(res, { threshold, count: breaches.length, breaches })
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
