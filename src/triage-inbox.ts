/**
 * Marveen Unified Triage Inbox
 *
 * Normalizes items from multiple channels (Telegram, email, future WhatsApp)
 * into one prioritized queue. This module is the deterministic classifier:
 * given a message's text (and optional subject) it assigns an urgency and an
 * intent, plus a numeric priority score used to order the unified queue.
 *
 * Hungarian-aware heuristics; dependency-free and testable. Like the other
 * extractors, classifyTriage() is the single seam an LLM classifier can
 * replace later without touching storage or ordering.
 */

export type Urgency = 'urgent' | 'normal' | 'low'
export type Intent = 'question' | 'request' | 'fyi'
export type Channel = 'telegram' | 'email' | 'whatsapp' | 'other'

export interface TriageClassification {
  urgency: Urgency
  intent: Intent
  score: number   // higher = handle sooner; used for queue ordering
}

const URGENT_CUES = [
  /\bsürg[őo]s/i, /\bazonnal/i, /\basap\b/i, /\bmiel[őo]bb/i,
  /\bhat[áa]rid[őo]/i, /\bma\b/i, /\bd[ée]lut[áa]nig?\b/i, /\bvészhelyzet/i,
  /\bnem m[űu]k[öo]dik/i, /\bhiba\b/i, /\bleállt\b/i,
]
const LOW_CUES = [
  /\br[áa][ée]rsz?\b/i, /\bmajd\b/i, /\bamikor (lesz|r[áa]érsz)/i,
  /\bnem s[üu]rg[őo]s/i, /\bcsak (sz[óo]lok|jelzem)\b/i,
]
const REQUEST_CUES = [
  /\bk[ée]rlek\b/i, /\btudn[áa]l\b/i, /\bcsin[áa]ld\b/i, /\bk[üu]ldj\b/i,
  /\bn[ée]zd meg\b/i, /\b[áa]llítsd\b/i, /\bjav[íi]tsd\b/i, /\bk[ée]szíts\b/i,
  /\bintézd?\b/i, /\bszervezd?\b/i,
]

/**
 * Classify a single inbox item.
 */
export function classifyTriage(text: string, subject?: string): TriageClassification {
  const hay = `${subject ?? ''} ${text ?? ''}`.trim()

  // Urgency. Check LOW cues first so explicit de-escalation ("nem sürgős",
  // "majd ráérsz") wins over a bare "sürgős" substring inside a negation.
  let urgency: Urgency = 'normal'
  if (LOW_CUES.some(re => re.test(hay))) urgency = 'low'
  else if (URGENT_CUES.some(re => re.test(hay))) urgency = 'urgent'

  // Intent
  let intent: Intent
  if (REQUEST_CUES.some(re => re.test(hay))) intent = 'request'
  else if (/\?/.test(hay)) intent = 'question'
  else intent = 'fyi'

  // Score: urgency dominates, then request > question > fyi.
  const urgencyScore = urgency === 'urgent' ? 100 : urgency === 'normal' ? 50 : 10
  const intentScore = intent === 'request' ? 6 : intent === 'question' ? 4 : 1
  // Exclamation / multiple question marks nudge it up a little.
  const emphasis = Math.min((hay.match(/[!?]/g) || []).length, 5)

  return { urgency, intent, score: urgencyScore + intentScore + emphasis }
}
