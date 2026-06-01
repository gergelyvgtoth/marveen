import { critiqueOutbound, type OutboundChannel } from '../../outbound-critic.js'
import { recordCriticSample, getCriticSuggestions, type CriticViolationSample } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleOutbound(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // POST /api/outbound-check { text, channel?, log? } -> { clean, violations }
  // Used by the PreToolUse hook (and the agent) to lint a message before send.
  // If log=true, the decision is recorded for the self-improving critic.
  if (path === '/api/outbound-check' && method === 'POST') {
    const body = await readBody(req)
    let data: { text?: string; channel?: string; log?: boolean }
    try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'invalid json' }, 400); return true }
    const channel = (data.channel as OutboundChannel) || 'telegram'
    const result = critiqueOutbound(data.text ?? '', channel)
    if (data.log) {
      try {
        const blocks: CriticViolationSample[] = result.violations.map(v => ({ rule: v.rule, match: v.match }))
        recordCriticSample(channel, !result.clean, blocks, data.text ?? '')
      } catch { /* logging is best-effort */ }
    }
    json(res, result)
    return true
  }

  // POST /api/outbound-critic/sample { channel, blocked, violations:[{rule,match}], text_preview }
  // Best-effort sink the PreToolUse hook posts blocked sends to.
  if (path === '/api/outbound-critic/sample' && method === 'POST') {
    const body = await readBody(req)
    let d: { channel?: string; blocked?: boolean; violations?: CriticViolationSample[]; text_preview?: string }
    try { d = JSON.parse(body.toString()) } catch { json(res, { error: 'invalid json' }, 400); return true }
    try { recordCriticSample(d.channel || 'telegram', !!d.blocked, d.violations || [], d.text_preview || '') } catch { /* best-effort */ }
    json(res, { ok: true })
    return true
  }

  // GET /api/outbound-critic/suggestions -> aggregate of what trips the gate
  if (path === '/api/outbound-critic/suggestions' && method === 'GET') {
    json(res, getCriticSuggestions())
    return true
  }

  return false
}
