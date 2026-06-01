/**
 * Marveen Knowledge Graph
 *
 * Turns flat memory text into a queryable entity-relation graph.
 * Entities (people, companies, machines, places) are extracted from memory
 * content with Hungarian-aware heuristics; relations are inferred from
 * co-occurrence within a single memory.
 *
 * Design: extraction is ON-DEMAND from the memories table (no separate
 * entity store to keep in sync), mirroring the similarity-graph endpoint.
 * The extractor is deterministic and dependency-free so it is unit-testable;
 * extractEntities() is the single seam where an LLM/Ollama extractor can be
 * swapped in later without touching the graph-building or API layers.
 */

export type EntityType = 'company' | 'person' | 'machine' | 'place' | 'other'

export interface Entity {
  name: string
  type: EntityType
}

export interface KgNode {
  id: string          // normalized entity key (lowercased name)
  label: string       // display name
  type: EntityType
  mentions: number    // how many memories mention it
}

export interface KgEdge {
  source: number      // index into nodes[]
  target: number      // index into nodes[]
  label: string       // relation label (cue verb or "együtt említve")
  weight: number      // co-occurrence count
}

export interface KgInput {
  id: number | string
  content: string
  keywords?: string | null
}

// Known agricultural-machine brands (Agrolánc domain). Multi-word brands are
// matched first so "John Deere 6120M" is one entity, not "John" + "Deere".
const MACHINE_BRANDS = [
  'John Deere', 'New Holland', 'Massey Ferguson', 'Case IH', 'Claas', 'Fendt',
  'Deutz-Fahr', 'Deutz', 'Kubota', 'Valtra', 'Steyr', 'Lamborghini', 'Same',
  'Krone', 'Pöttinger', 'Horsch', 'Väderstad', 'Amazone', 'Kuhn', 'Lemken',
]

// Curated proper nouns that should always resolve to a known entity/type.
const KNOWN_ENTITIES: { pattern: RegExp; name: string; type: EntityType }[] = [
  { pattern: /\bAgrol[áa]nc\b/i, name: 'Agrolánc', type: 'company' },
  { pattern: /\bM[űu]tacsi\b/i, name: 'Műtacsi', type: 'company' },
  { pattern: /\bGergely\b/, name: 'Gergely', type: 'person' },
  { pattern: /\bSz[ée]chenyi(\s+Egyetem)?\b/i, name: 'Széchenyi Egyetem', type: 'place' },
]

const COMPANY_SUFFIX = /(Kft|Zrt|Bt|Nyrt|Kkt|Kht|Rt|ZT)\.?/

// Company: a capitalized run ending in a Hungarian legal-form suffix.
const COMPANY_RE = new RegExp(
  `\\b([A-ZÁÉÍÓÖŐÚÜŰ][\\wÁÉÍÓÖŐÚÜŰáéíóöőúüű.&-]*(?:\\s+[A-ZÁÉÍÓÖŐÚÜŰ0-9][\\wÁÉÍÓÖŐÚÜŰáéíóöőúüű.&-]*){0,3})\\s+${COMPANY_SUFFIX.source}`,
  'g'
)

// Machine model token, e.g. "6120M", "T7.210", "Axion 850".
const MODEL_RE = /\b([A-Z]{0,3}\d{2,4}(?:[.-]\d{1,3})?[A-Z]{0,2})\b/

// Relation cue verbs (Hungarian). If one appears in a memory, edges from that
// memory are labeled with it instead of the generic co-mention label.
const RELATION_CUES: { re: RegExp; label: string }[] = [
  { re: /érdekl[őo]d/i, label: 'érdeklődött' },
  { re: /\baj[áa]nlat/i, label: 'ajánlat' },
  { re: /\bt[áa]rgyal/i, label: 'tárgyalás' },
  { re: /\bvett|v[áa]s[áa]rol|megrendel/i, label: 'vásárolt' },
  { re: /\bszerz[őo]d/i, label: 'szerződés' },
  { re: /\b[üu]gyvezet|tulajdonos|vezet[őo]/i, label: 'kapcsolattartó' },
  { re: /\bszerviz|jav[íi]t/i, label: 'szerviz' },
]

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

function dedupePush(out: Entity[], seen: Set<string>, e: Entity): void {
  const key = normalizeKey(e.name)
  if (!key || seen.has(key)) return
  seen.add(key)
  out.push(e)
}

/**
 * Extract entities from a single piece of text.
 * THE EXTRACTION SEAM: replace this body with an LLM/Ollama call to upgrade
 * extraction quality; the rest of the graph layer is unaffected.
 */
export function extractEntities(text: string): Entity[] {
  if (!text) return []
  const out: Entity[] = []
  const seen = new Set<string>()

  // 1. Curated known entities (highest precedence).
  for (const k of KNOWN_ENTITIES) {
    if (k.pattern.test(text)) dedupePush(out, seen, { name: k.name, type: k.type })
  }

  // 2. Companies (legal-form suffix). Strip a leading Hungarian determiner
  // ("A"/"Az"/"Egy") that gets captured when the company starts a sentence,
  // so "Az XY Kft" and "XY Kft" collapse to the same entity.
  for (const m of text.matchAll(COMPANY_RE)) {
    const full = m[0].replace(/\s+/g, ' ').trim().replace(/^(A|Az|Egy)\s+/, '')
    dedupePush(out, seen, { name: full, type: 'company' })
  }

  // 3. Machines: known brand, optionally followed by a model token.
  for (const brand of MACHINE_BRANDS) {
    const brandRe = new RegExp(`\\b${brand.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b(\\s+${MODEL_RE.source})?`, 'gi')
    for (const m of text.matchAll(brandRe)) {
      const name = m[0].replace(/\s+/g, ' ').trim()
      dedupePush(out, seen, { name, type: 'machine' })
    }
  }

  return out
}

/**
 * Build a knowledge graph from a set of memories.
 * Entities are nodes; two entities sharing a memory produce/strengthen an edge.
 * If `focus` is given, only the focused entity and its direct neighbours are
 * returned (1-hop ego graph).
 */
export function buildKnowledgeGraph(memories: KgInput[], focus?: string): { nodes: KgNode[]; edges: KgEdge[] } {
  const nodeMap = new Map<string, KgNode>()        // key -> node
  const edgeMap = new Map<string, KgEdge & { sKey: string; tKey: string }>()

  const upsertNode = (e: Entity): KgNode => {
    const key = normalizeKey(e.name)
    let n = nodeMap.get(key)
    if (!n) { n = { id: key, label: e.name, type: e.type, mentions: 0 }; nodeMap.set(key, n) }
    n.mentions++
    return n
  }

  for (const mem of memories) {
    const text = `${mem.content} ${mem.keywords ?? ''}`
    const entities = extractEntities(text)
    if (!entities.length) continue

    // Label edges from this memory with the first matching relation cue.
    let label = 'együtt említve'
    for (const c of RELATION_CUES) { if (c.re.test(text)) { label = c.label; break } }

    const keys = entities.map(upsertNode).map(n => n.id)
    // Pairwise co-occurrence edges (undirected, keyed by sorted pair).
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const [a, b] = keys[i] < keys[j] ? [keys[i], keys[j]] : [keys[j], keys[i]]
        if (a === b) continue
        const ek = `${a}|${b}`
        const existing = edgeMap.get(ek)
        if (existing) {
          existing.weight++
          if (existing.label === 'együtt említve' && label !== 'együtt említve') existing.label = label
        } else {
          edgeMap.set(ek, { sKey: a, tKey: b, source: -1, target: -1, label, weight: 1 })
        }
      }
    }
  }

  let nodes = [...nodeMap.values()]
  let edges = [...edgeMap.values()]

  // Focus: keep the entity + its direct neighbours only.
  if (focus) {
    const fKey = normalizeKey(focus)
    if (nodeMap.has(fKey)) {
      const keep = new Set<string>([fKey])
      for (const e of edges) {
        if (e.sKey === fKey) keep.add(e.tKey)
        if (e.tKey === fKey) keep.add(e.sKey)
      }
      nodes = nodes.filter(n => keep.has(n.id))
      edges = edges.filter(e => keep.has(e.sKey) && keep.has(e.tKey))
    }
  }

  // Resolve edge endpoints to node indices for the force-directed renderer.
  const indexOf = new Map<string, number>()
  nodes.forEach((n, i) => indexOf.set(n.id, i))
  const resolvedEdges: KgEdge[] = edges
    .filter(e => indexOf.has(e.sKey) && indexOf.has(e.tKey))
    .map(e => ({ source: indexOf.get(e.sKey)!, target: indexOf.get(e.tKey)!, label: e.label, weight: e.weight }))

  return { nodes, edges: resolvedEdges }
}
