/**
 * Marveen Sales Opportunity Scoring
 *
 * Turns the knowledge graph into a decision input: for each company entity
 * mentioned in memory, score the opportunity from signals found in the
 * memories that mention it (open offer, machine interest, negotiation
 * recency, named contact). Produces a ranked daily list so sales attention
 * goes to the highest-potential customers first.
 *
 * Reuses the dependency-free entity extractor; deterministic and testable
 * (recency uses a passed-in `nowTs`, never Date.now()).
 */
import { extractEntities, type KgInput } from './knowledge-graph.js'

export interface ScoredMemory extends KgInput {
  created_at: number
}

export interface OpportunitySignal {
  kind: 'open_offer' | 'machine_interest' | 'recent_negotiation' | 'contact' | 'purchase'
  weight: number
  note: string
}

export interface Opportunity {
  company: string
  score: number
  signals: OpportunitySignal[]
  lastMentionTs: number
}

// NOTE: no \b anchors. JS \b is ASCII-only, so \b before an accented initial
// (érdeklőd, ügyvezet) never matches -- substring cues are what we want here.
const SIGNAL_CUES = {
  open_offer: /aj[áa]nlat/i,
  offer_closed: /(megrendel|szerz[őo]d[ée]s al[áa][íi]rva|elutas[íi]t|lez[áa]r)/i,
  machine_interest: /(érdekl[őo]d|traktor|komb[áa]jn|g[ée]p)/i,
  negotiation: /t[áa]rgyal/i,
  purchase: /(vett|v[áa]s[áa]rol|megrendel)/i,
  contact: /([üu]gyvezet|tulajdonos|kapcsolattart|d[öo]nt[ée]shoz)/i,
}

const SEVEN_DAYS = 7 * 86400
const THIRTY_DAYS = 30 * 86400

/**
 * Compute ranked sales opportunities from scored memories.
 * @param nowTs current unix time (seconds) -- passed in for deterministic tests.
 */
export function computeOpportunities(memories: ScoredMemory[], nowTs: number): Opportunity[] {
  // company key -> { display, signals, lastTs, texts }
  const acc = new Map<string, { display: string; signals: OpportunitySignal[]; lastTs: number }>()

  for (const mem of memories) {
    const text = `${mem.content} ${mem.keywords ?? ''}`
    const companies = extractEntities(text).filter(e => e.type === 'company')
    if (!companies.length) continue

    const signals: OpportunitySignal[] = []
    const offerClosed = SIGNAL_CUES.offer_closed.test(text)
    if (SIGNAL_CUES.open_offer.test(text) && !offerClosed) {
      signals.push({ kind: 'open_offer', weight: 40, note: 'nyitott ajánlat' })
    }
    if (SIGNAL_CUES.machine_interest.test(text)) {
      signals.push({ kind: 'machine_interest', weight: 20, note: 'gép-érdeklődés' })
    }
    if (SIGNAL_CUES.negotiation.test(text)) {
      // Recency-weighted: fresh negotiation worth more than stale.
      const age = nowTs - mem.created_at
      const w = age <= SEVEN_DAYS ? 30 : age <= THIRTY_DAYS ? 18 : 8
      signals.push({ kind: 'recent_negotiation', weight: w, note: age <= SEVEN_DAYS ? 'friss tárgyalás' : 'korábbi tárgyalás' })
    }
    if (SIGNAL_CUES.purchase.test(text)) {
      signals.push({ kind: 'purchase', weight: 10, note: 'vásárlási jel' })
    }
    if (SIGNAL_CUES.contact.test(text)) {
      signals.push({ kind: 'contact', weight: 8, note: 'kapcsolattartó ismert' })
    }
    if (!signals.length) continue

    for (const c of companies) {
      const key = c.name.toLowerCase()
      const cur = acc.get(key) ?? { display: c.name, signals: [], lastTs: 0 }
      cur.signals.push(...signals)
      cur.lastTs = Math.max(cur.lastTs, mem.created_at)
      acc.set(key, cur)
    }
  }

  const out: Opportunity[] = []
  for (const v of acc.values()) {
    // De-duplicate signal kinds, keeping the highest weight per kind, so a
    // company mentioned 5x with "ajánlat" isn't scored 5x for the same thing.
    const best = new Map<string, OpportunitySignal>()
    for (const s of v.signals) {
      const prev = best.get(s.kind)
      if (!prev || s.weight > prev.weight) best.set(s.kind, s)
    }
    const signals = [...best.values()]
    const score = signals.reduce((sum, s) => sum + s.weight, 0)
    out.push({ company: v.display, score, signals, lastMentionTs: v.lastTs })
  }

  return out.sort((a, b) => b.score - a.score || b.lastMentionTs - a.lastMentionTs)
}
