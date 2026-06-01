import { critiqueOutbound, type OutboundChannel } from '../../outbound-critic.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleOutbound(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // POST /api/outbound-check { text, channel? } -> { clean, violations }
  // Used by the PreToolUse hook (and the agent) to lint a message before send.
  if (path === '/api/outbound-check' && method === 'POST') {
    const body = await readBody(req)
    let data: { text?: string; channel?: string }
    try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'invalid json' }, 400); return true }
    const channel = (data.channel as OutboundChannel) || 'telegram'
    json(res, critiqueOutbound(data.text ?? '', channel))
    return true
  }

  return false
}
