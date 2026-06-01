/**
 * Marveen Session Replay + Regression Harness
 *
 * A session is recorded as an ordered list of events (inbound messages, tool
 * calls with their outcome, replies). Recordings are immutable fixtures.
 *
 * The regression engine deterministically diffs a BASELINE recording against
 * a CANDIDATE recording of the same scenario (e.g. captured after a prompt or
 * skill change) and flags what changed: tool calls added/removed, outcome
 * flips (success -> fail), and tool-call order changes. This is the practical
 * core of "did my change break how Marveen handles X" without needing to
 * re-drive the live agent.
 *
 * (A future layer can re-execute the agent against mocked tool outputs for
 * true bit-for-bit replay; this module is the deterministic comparison seam.)
 */

export type EventType = 'inbound' | 'tool' | 'reply'
export type Outcome = 'success' | 'fail'

export interface SessionEvent {
  type: EventType
  name?: string          // tool name (for type==='tool')
  input?: string         // short input summary
  outcome?: Outcome      // for tool calls
}

export interface SessionRecording {
  id?: number
  name: string
  scenario: string
  events: SessionEvent[]
}

export interface OutcomeFlip {
  tool: string
  index: number
  baseline: Outcome
  candidate: Outcome
}

export interface RegressionDiff {
  identical: boolean
  isRegression: boolean
  toolsAdded: string[]       // tools called in candidate but not baseline (by name, multiset)
  toolsRemoved: string[]     // tools in baseline but not candidate
  orderChanged: boolean      // tool-name sequence differs (ignoring add/remove)
  outcomeFlips: OutcomeFlip[]// tools whose outcome changed success<->fail at the same position
  summary: string
}

function toolSequence(events: SessionEvent[]): { name: string; outcome: Outcome }[] {
  return events
    .filter(e => e.type === 'tool' && e.name)
    .map(e => ({ name: e.name as string, outcome: (e.outcome ?? 'success') as Outcome }))
}

function multisetDiff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const count = new Map<string, number>()
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1)
  for (const x of b) count.set(x, (count.get(x) ?? 0) - 1)
  const onlyA: string[] = []   // positive count -> more in a (baseline) than b
  const onlyB: string[] = []
  for (const [name, c] of count) {
    for (let i = 0; i < c; i++) onlyA.push(name)
    for (let i = 0; i < -c; i++) onlyB.push(name)
  }
  return { onlyA: onlyA.sort(), onlyB: onlyB.sort() }
}

/**
 * Deterministically compare a baseline against a candidate recording.
 */
export function compareRecordings(baseline: SessionRecording, candidate: SessionRecording): RegressionDiff {
  const bSeq = toolSequence(baseline.events)
  const cSeq = toolSequence(candidate.events)
  const bNames = bSeq.map(t => t.name)
  const cNames = cSeq.map(t => t.name)

  const { onlyA: toolsRemoved, onlyB: toolsAdded } = multisetDiff(bNames, cNames)

  // Order change: same multiset of tools but different sequence.
  const orderChanged = toolsRemoved.length === 0 && toolsAdded.length === 0 &&
    bNames.join('>') !== cNames.join('>')

  // Outcome flips: compare position-by-position while the tool names align.
  const outcomeFlips: OutcomeFlip[] = []
  const n = Math.min(bSeq.length, cSeq.length)
  for (let i = 0; i < n; i++) {
    if (bSeq[i].name === cSeq[i].name && bSeq[i].outcome !== cSeq[i].outcome) {
      outcomeFlips.push({ tool: bSeq[i].name, index: i, baseline: bSeq[i].outcome, candidate: cSeq[i].outcome })
    }
  }

  const identical = toolsAdded.length === 0 && toolsRemoved.length === 0 && !orderChanged && outcomeFlips.length === 0

  // Regression = a previously-succeeding tool removed, OR a success->fail flip.
  const successFlip = outcomeFlips.some(f => f.baseline === 'success' && f.candidate === 'fail')
  const removedSuccess = toolsRemoved.length > 0 && bSeq.some(t => toolsRemoved.includes(t.name) && t.outcome === 'success')
  const isRegression = successFlip || removedSuccess

  const parts: string[] = []
  if (identical) parts.push('Azonos lefutás.')
  if (toolsAdded.length) parts.push(`+${toolsAdded.length} új tool-hívás (${[...new Set(toolsAdded)].join(', ')})`)
  if (toolsRemoved.length) parts.push(`-${toolsRemoved.length} kimaradt tool-hívás (${[...new Set(toolsRemoved)].join(', ')})`)
  if (orderChanged) parts.push('Tool-sorrend megváltozott.')
  if (outcomeFlips.length) parts.push(`${outcomeFlips.length} kimenetel-váltás`)
  if (isRegression) parts.push('⚠️ REGRESSZIÓ')

  return { identical, isRegression, toolsAdded, toolsRemoved, orderChanged, outcomeFlips, summary: parts.join(' ') || 'Nincs eltérés.' }
}
