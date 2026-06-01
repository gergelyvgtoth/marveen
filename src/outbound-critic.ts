/**
 * Marveen Outbound Self-Critic
 *
 * Mechanically enforces the CLAUDE.md "soha" (never) rules on any outgoing
 * message (Telegram reply, email) BEFORE it is sent. Returns a list of
 * violations so a PreToolUse hook (or the agent itself) can block or rewrite.
 *
 * This is a deterministic lint, not an LLM judgment: every rule here maps to
 * an explicit, non-negotiable line in CLAUDE.md, so a regex is the right tool
 * and the result is reproducible and testable.
 */

export type OutboundChannel = 'telegram' | 'email' | 'other'
export type Severity = 'block' | 'warn'

export interface Violation {
  rule: string
  severity: Severity
  message: string
  match?: string
}

export interface CritiqueResult {
  clean: boolean        // true if no 'block' violations
  violations: Violation[]
}

// AI clichés explicitly banned in CLAUDE.md (+ close variants).
const CLICHE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bTermészetesen\b/i, label: 'Természetesen' },
  { re: /\bRemek kérdés\b/i, label: 'Remek kérdés' },
  { re: /\bSzívesen segít(ek|ünk)\b/i, label: 'Szívesen segítek' },
  { re: /\bMint (egy )?(mesterséges intelligencia|AI|nyelvi modell)\b/i, label: 'Mint mesterséges intelligencia' },
]

// Email signature lines that must NEVER appear in Telegram.
const SIGNATURE_PATTERNS = [
  /Marveen,\s*Gergely AI asszisztense/i,
  /Brain the size of a planet/i,
]

// Secret / internal-data leakage patterns.
const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /Bearer\s+[A-Za-z0-9._-]{12,}/, label: 'Bearer token' },
  { re: /\.dashboard-token/, label: 'dashboard-token hivatkozás' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, label: 'API kulcs (sk-...)' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/, label: 'GitHub token' },
  { re: /\/home\/user\/marveen(?:\/[^\s)'"]*)?/, label: 'belső abszolút útvonal' },
  { re: /\b[0-9a-f]{32,}\b/, label: 'hosszú hex titok-gyanú' },
]

// Over-apology cues (CLAUDE.md: "Nincs túlzott bocsánatkérés").
const APOLOGY_PATTERNS = [
  /\bnagyon sajnálom\b/i,
  /\b(elnézést|bocsánat)\b.*\b(elnézést|bocsánat)\b/is,
  /\bezerszer (is )?elnézést\b/i,
]

/**
 * Critique an outbound message. `channel` defaults to 'telegram'.
 */
export function critiqueOutbound(text: string, channel: OutboundChannel = 'telegram'): CritiqueResult {
  const violations: Violation[] = []
  if (!text) return { clean: true, violations }

  // 1. Em dash / en dash used as punctuation (CLAUDE.md: "Nincs gondolatjel").
  const dash = text.match(/[—–]/)
  if (dash) {
    violations.push({
      rule: 'em-dash',
      severity: 'block',
      message: 'Gondolatjel (— vagy –) tilos. Használj sima kötőjelet vagy fogalmazd át.',
      match: dash[0],
    })
  }

  // 2. AI clichés.
  for (const c of CLICHE_PATTERNS) {
    const m = text.match(c.re)
    if (m) violations.push({ rule: 'ai-cliche', severity: 'block', message: `AI klisé tilos: "${c.label}".`, match: m[0] })
  }

  // 3. Email signature in non-email channels.
  if (channel !== 'email') {
    for (const re of SIGNATURE_PATTERNS) {
      const m = text.match(re)
      if (m) {
        violations.push({ rule: 'signature-leak', severity: 'block', message: 'Email aláírás csak emailbe való, Telegramra soha.', match: m[0] })
        break
      }
    }
  }

  // 4. Secret / internal-data leakage.
  for (const s of SECRET_PATTERNS) {
    const m = text.match(s.re)
    if (m) violations.push({ rule: 'secret-leak', severity: 'block', message: `Lehetséges belső adat kiszivárgás: ${s.label}.`, match: m[0] })
  }

  // 5. Over-apology (warn only).
  for (const re of APOLOGY_PATTERNS) {
    const m = text.match(re)
    if (m) { violations.push({ rule: 'over-apology', severity: 'warn', message: 'Túlzott bocsánatkérés. Javítsd és menj tovább.', match: m[0] }); break }
  }

  const clean = !violations.some(v => v.severity === 'block')
  return { clean, violations }
}
