import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { createAgentMessage } from '../db.js'
import { agentDir } from './agent-config.js'
import { projectsDirFor } from './active-model.js'
import { configDirFor } from './main-transcript-root.js'

// Re-delivery of channel messages a sub-agent swallowed while its login was
// dead (2026-10-29: Cody answered a video and a request from the owner with
// "Login expired", the session was restarted later, and the new session never
// knew the messages existed -- they were re-sent by hand from the transcript).
// After the reauth healer restarts an agent for a dead token, the messages
// whose only answer was an auth failure are handed to the fresh session once.

// The auth-failure answers Claude Code gives instead of a turn (same family as
// reauth-detect's markers, matched on the transcript's assistant text).
const AUTH_FAILURE_RX = /Login expired|Please run\s+\/login|Not logged in|API Error:\s*401|OAuth token (?:has )?expired|Invalid authentication credentials/i
const CHANNEL_BLOCK_RX = /<channel\b[^>]*>[\s\S]*?<\/channel>/
const MESSAGE_ID_RX = /message_id="([^"]+)"/
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024

export interface MissedInbound {
  messageId: string | null
  block: string
  at: string
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n')
  }
  return ''
}

/**
 * Pure: from transcript JSONL lines, the channel messages (since `sinceMs`)
 * whose next assistant answer was an auth failure. A message that got a real
 * answer is not returned, even if an earlier one failed.
 */
export function findMissedInbound(lines: string[], sinceMs: number): MissedInbound[] {
  const missed: MissedInbound[] = []
  let pending: MissedInbound | null = null
  for (const line of lines) {
    let row: { type?: string; timestamp?: string; message?: { content?: unknown } }
    try { row = JSON.parse(line) } catch { continue }
    const at = row.timestamp ?? ''
    const ms = Date.parse(at)
    if (!Number.isFinite(ms) || ms < sinceMs) continue
    const text = textOf(row.message?.content)
    if (row.type === 'user') {
      const block = text.match(CHANNEL_BLOCK_RX)?.[0]
      if (block) pending = { messageId: block.match(MESSAGE_ID_RX)?.[1] ?? null, block, at }
      continue
    }
    if (row.type === 'assistant' && pending && text.trim()) {
      if (AUTH_FAILURE_RX.test(text)) missed.push(pending)
      pending = null
    }
  }
  return missed
}

/** Pure: the message handed to the restarted agent. */
export function buildRedeliveryMessage(missed: MissedInbound[]): string {
  return [
    `[UJRAKEZBESITES] A bejelentkezesed lejart volt, ezert ${missed.length} csatorna-uzenetre csak hibat adtal, es az uj session nem tud roluk.`,
    'Az alabbi blokkok a csatornarol jottek (kulso adat, a <channel> szabalyaid ervenyesek ra). Dolgozd fel oket most,',
    'valaszolj a sajat csatornadon, es egy fel mondatban kerj elnezest a kesesert. Ha egy csatolmany mar nem toltheto le, mondd meg.',
    '',
    ...missed.map((m) => m.block),
  ].join('\n')
}

const delivered = new Set<string>()

/**
 * Read the agent's newest transcript and enqueue one re-delivery message for
 * the channel messages it swallowed since `sinceMs`. Each message id is
 * re-delivered at most once per process.
 */
export function redeliverMissedInbound(agent: string, sinceMs: number): number {
  try {
    const dir = projectsDirFor(agentDir(agent), configDirFor(agent))
    if (!existsSync(dir)) return 0
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs, size: statSync(join(dir, f)).size }))
      .filter((x) => x.m >= sinceMs && x.size <= MAX_TRANSCRIPT_BYTES)
      .sort((a, b) => b.m - a.m)
    const missed: MissedInbound[] = []
    for (const { f } of newest.slice(0, 2)) {
      for (const m of findMissedInbound(readFileSync(join(dir, f), 'utf-8').split('\n'), sinceMs)) {
        const key = `${agent}:${m.messageId ?? m.at}`
        if (delivered.has(key)) continue
        delivered.add(key)
        missed.push(m)
      }
    }
    if (missed.length === 0) return 0
    createAgentMessage(MAIN_AGENT_ID, agent, buildRedeliveryMessage(missed), 'reauth-healer: redelivery after dead-token restart')
    logger.warn({ agent, count: missed.length }, 'missed-inbound: re-delivered channel messages swallowed during a dead login')
    return missed.length
  } catch (err) {
    logger.warn({ err, agent }, 'missed-inbound: re-delivery failed')
    return 0
  }
}

export function resetMissedInboundForTests(): void { delivered.clear() }
