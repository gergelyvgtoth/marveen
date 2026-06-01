import {
  saveAgentMemory, getAgentMemories, searchAgentMemories, getMemoryStats, updateMemory,
  hybridSearch, backfillEmbeddings,
  searchMemories, getMemoriesForChat, getDb,
  getOutboundAudit, getOutboundAuditStats,
  type Memory,
} from '../../db.js'
import { MAIN_AGENT_ID, ALLOWED_CHAT_ID, OLLAMA_URL } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { maskPII } from '../../pii-filter.js'
import { inferSensitivity, applyPolicyRules } from '../../data-gate.js'
import type { RouteContext } from './types.js'

async function broadcastSharedMemory(fromAgent: string, content: string, keywords?: string): Promise<void> {
  try {
    const { listAgentNames } = await import('../agent-config.js')
    const { isAgentRunning } = await import('../agent-process.js')
    const db = getDb()
    const allAgents = listAgentNames().filter(n => n !== fromAgent && isAgentRunning(n))
    if (!allAgents.length) return
    const msg = `[Shared memória @${fromAgent}]: ${content}${keywords ? ` (kulcsszavak: ${keywords})` : ''}`
    for (const agentName of allAgents) {
      db.prepare(
        `INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at)
         VALUES (?, ?, ?, 'pending', unixepoch())`
      ).run(fromAgent, agentName, msg)
    }
    logger.info({ from: fromAgent, targets: allAgents }, 'Shared memory broadcast sent')
  } catch (err) {
    logger.warn({ err }, 'broadcastSharedMemory failed (non-fatal)')
  }
}

// Canonical memory categories. Kept in sync with the DB CHECK constraint in
// src/db.ts so the API rejects bad values before they even reach SQLite.
const MEMORY_CATEGORIES = new Set(['hot', 'warm', 'cold', 'shared'])

const SUSPICIOUS_PATTERNS = [
  /\bcurl\s+(-[a-zA-Z]\s+)*https?:\/\//i,
  /\bbash\s+-c\b/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /\bimport\s+subprocess\b/i,
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /override\s+your\s+(instructions|rules|safety|guidelines)/i,
  /forget\s+your\s+(instructions|rules|safety|guidelines|training)/i,
  /new\s+persona/i,
  /\brm\s+-rf\b/i,
]

function containsSuspiciousContent(content: string): boolean {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(content))
}

export async function tryHandleMemories(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/memories' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id?: string; content: string; tier?: string; category?: string; keywords?: string }
    if (!data.content?.trim()) { json(res, { error: 'Content is required' }, 400); return true }
    if (containsSuspiciousContent(data.content)) {
      logger.warn({ agent: data.agent_id }, 'Memory content rejected: suspicious pattern')
      json(res, { error: 'Content rejected by security filter' }, 400)
      return true
    }
    if (data.tier && !data.category) {
      logger.warn({ agent: data.agent_id }, '[DEPRECATED] /api/memories: use "category" instead of "tier"')
    }
    const category = (data.category || data.tier || 'warm').toLowerCase()
    if (!MEMORY_CATEGORIES.has(category)) {
      json(res, { error: `Invalid category "${category}". Allowed: ${[...MEMORY_CATEGORIES].join(', ')}` }, 400)
      return true
    }
    const agentId = data.agent_id || MAIN_AGENT_ID
    const safeContent = maskPII(data.content.trim())

    // Infer sensitivity and apply policy rules for scope/ttl
    const sensitivity = (data as { sensitivity?: string }).sensitivity as import('../../data-gate.js').Sensitivity | undefined
      ?? inferSensitivity(safeContent, category)
    const policyResult = applyPolicyRules(sensitivity)
    const expiresAt = policyResult.ttl_days
      ? Math.floor(Date.now() / 1000) + policyResult.ttl_days * 86400
      : null

    const result = saveAgentMemory(
      agentId,
      safeContent,
      category,
      data.keywords || undefined,
      true
    )

    // Apply scope + ttl to the saved memory
    const db = getDb()
    db.prepare(
      'UPDATE memories SET sensitivity = ?, scope = ?, ttl_days = ?, expires_at = ? WHERE id = ?'
    ).run(sensitivity, policyResult.scope, policyResult.ttl_days, expiresAt, result.id)

    json(res, { ok: true, id: result.id, sensitivity, scope: policyResult.scope })

    // Cross-agent broadcast for shared-tier memories
    if (category === 'shared' && safeContent.length > 20) {
      broadcastSharedMemory(agentId, safeContent, data.keywords).catch(() => {})
    }

    return true
  }

  if (path === '/api/memories' && method === 'GET') {
    const q = url.searchParams.get('q')?.trim() || ''
    const agentId = url.searchParams.get('agent') || ''
    const tier = url.searchParams.get('tier') || url.searchParams.get('category') || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    const mode = url.searchParams.get('mode') || 'fts'

    let results: Memory[]
    if (q && mode === 'hybrid') {
      results = await hybridSearch(agentId || MAIN_AGENT_ID, q, limit)
    } else if (q && agentId) {
      results = searchAgentMemories(agentId, q, limit)
      if (results.length === 0) {
        const db2 = getDb()
        results = db2.prepare("SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?) ORDER BY accessed_at DESC LIMIT ?")
          .all(agentId, `%${q}%`, `%${q}%`, limit) as Memory[]
      }
    } else if (q) {
      results = searchMemories(q, ALLOWED_CHAT_ID, limit)
      if (results.length === 0) {
        const db2 = getDb()
        results = db2.prepare('SELECT * FROM memories WHERE content LIKE ? ORDER BY accessed_at DESC LIMIT ?').all(`%${q}%`, limit) as Memory[]
      }
    } else if (agentId) {
      results = getAgentMemories(agentId, limit)
    } else {
      results = getMemoriesForChat(ALLOWED_CHAT_ID, limit)
    }

    if (tier) results = results.filter(m => m.category === tier)

    const formatted = results.map(m => ({
      ...m,
      embedding: undefined,
      created_label: new Date(m.created_at * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }),
      accessed_label: new Date(m.accessed_at * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }),
    }))
    json(res, formatted)
    return true
  }

  if (path === '/api/memories/import' && method === 'POST') {
    const body = await readBody(req)
    const { agent_id, chunks } = JSON.parse(body.toString()) as { agent_id: string; chunks: string[] }

    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      json(res, { error: 'No chunks to import' }, 400)
      return true
    }

    const agentId = agent_id || MAIN_AGENT_ID
    const stats = { hot: 0, warm: 0, cold: 0, shared: 0 }
    let imported = 0

    let categorizeModel: string | null = null
    try {
      const ollamaModels = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
        .then(r => r.json())
        .then((d: any) => (d.models || []).filter((m: any) => !m.name.includes('embed')).map((m: any) => m.name))
        .catch(() => [] as string[])
      categorizeModel = ollamaModels.find((m: string) => m.includes('gemma4')) || ollamaModels[0] || null
    } catch {
      categorizeModel = null
    }

    if (categorizeModel) {
      logger.info({ model: categorizeModel }, 'Migráció: AI kategorizálás modell kiválasztva')
    } else {
      logger.info('Migráció: nincs elérhető Ollama modell, alapértelmezett warm besorolás')
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]

      if (!categorizeModel) {
        saveAgentMemory(agentId, chunk, 'warm', '', true)
        stats.warm++
        imported++
        continue
      }

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 90000)

        const catResponse = await fetch(`${OLLAMA_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: categorizeModel,
            prompt: `Categorize this memory into exactly one tier and generate keywords.

Memory: "${chunk.slice(0, 500)}"

Tiers:
- hot: active tasks, pending decisions, things happening NOW
- warm: preferences, config, project context, stable knowledge
- cold: long-term lessons, historical decisions, archive
- shared: information relevant to multiple agents

Respond ONLY with JSON, nothing else:
{"tier": "warm", "keywords": "keyword1, keyword2, keyword3"}`,
            stream: false,
          }),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const catData = await catResponse.json() as { response?: string }

        let tier = 'warm'
        let keywords = ''

        try {
          const jsonMatch = (catData.response || '').match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            tier = ['hot', 'warm', 'cold', 'shared'].includes(parsed.tier) ? parsed.tier : 'warm'
            keywords = parsed.keywords || ''
          }
        } catch {
          // Default to warm if parsing fails
        }

        saveAgentMemory(agentId, chunk, tier, keywords, true)
        stats[tier as keyof typeof stats]++
        imported++

        if (i < chunks.length - 1) {
          await new Promise(r => setTimeout(r, 200))
        }
      } catch {
        saveAgentMemory(agentId, chunk, 'warm', '', true)
        stats.warm++
        imported++
      }
    }

    logger.info({ agentId, imported, stats }, 'Migráció befejezve')
    json(res, { ok: true, imported, stats })
    return true
  }

  if (path === '/api/memories/backfill' && method === 'POST') {
    try {
      const count = await backfillEmbeddings()
      json(res, { ok: true, count })
    } catch (err) {
      logger.error({ err }, 'Backfill failed')
      json(res, { error: 'Backfill failed' }, 500)
    }
    return true
  }

  // GET /api/memories/similarity-graph?agent=marveen&threshold=0.35
  if (path === '/api/memories/similarity-graph' && method === 'GET') {
    const agentId = url.searchParams.get('agent') || MAIN_AGENT_ID
    const threshold = parseFloat(url.searchParams.get('threshold') || '0.35')
    const db = getDb()
    const rows = db.prepare(
      `SELECT id, content, category, keywords, agent_id, embedding FROM memories
       WHERE agent_id = ? AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 100`
    ).all(agentId) as { id: number; content: string; category: string; keywords: string; agent_id: string; embedding: string }[]

    const nodes = rows.map(r => ({
      id: r.id,
      label: r.content.slice(0, 40).replace(/\n/g, ' ') + (r.content.length > 40 ? '...' : ''),
      category: r.category,
      keywords: r.keywords,
      agent_id: r.agent_id,
    }))

    // Compute cosine similarity between all pairs
    const embeddings = rows.map(r => {
      try { return JSON.parse(r.embedding) as number[] } catch { return null }
    })

    function cosineSim(a: number[], b: number[]): number {
      let dot = 0, na = 0, nb = 0
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
      return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
    }

    const edges: { source: number; target: number; similarity: number }[] = []
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const ea = embeddings[i], eb = embeddings[j]
        if (!ea || !eb) continue
        const sim = cosineSim(ea, eb)
        if (sim >= threshold) {
          edges.push({ source: i, target: j, similarity: Math.round(sim * 1000) / 1000 })
        }
      }
    }

    json(res, { nodes, edges })
    return true
  }

  // GET /api/memories/knowledge-graph?agent=marveen&focus=Agrolánc
  // Entity-relation graph extracted from memory text (not similarity-based).
  if (path === '/api/memories/knowledge-graph' && method === 'GET') {
    const agentId = url.searchParams.get('agent') || MAIN_AGENT_ID
    const focus = url.searchParams.get('focus') || undefined
    const db = getDb()
    const rows = db.prepare(
      `SELECT id, content, keywords FROM memories
       WHERE (agent_id = ? OR category = 'shared') ORDER BY created_at DESC LIMIT 500`
    ).all(agentId) as { id: number; content: string; keywords: string | null }[]
    const { buildKnowledgeGraph } = await import('../../knowledge-graph.js')
    const graph = buildKnowledgeGraph(rows, focus)
    json(res, graph)
    return true
  }

  if (path === '/api/memories/stats' && method === 'GET') {
    json(res, getMemoryStats())
    return true
  }

  // POST /api/memories/forget -- delete by sensitivity/scope/age (marveen forget)
  if (path === '/api/memories/forget' && method === 'POST') {
    const body = await readBody(req)
    const params = JSON.parse(body.toString()) as {
      sensitivity?: string
      scope?: string
      older_than_days?: number
      agent_id?: string
    }
    const db = getDb()
    const conditions: string[] = []
    const args: unknown[] = []
    if (params.sensitivity) { conditions.push('sensitivity = ?'); args.push(params.sensitivity) }
    if (params.scope) { conditions.push('scope = ?'); args.push(params.scope) }
    if (params.older_than_days) {
      const cutoff = Math.floor(Date.now() / 1000) - params.older_than_days * 86400
      conditions.push('created_at < ?'); args.push(cutoff)
    }
    if (params.agent_id) { conditions.push('agent_id = ?'); args.push(params.agent_id) }
    if (conditions.length === 0) { json(res, { error: 'At least one filter required' }, 400); return true }
    const count = db.prepare(`DELETE FROM memories WHERE ${conditions.join(' AND ')}`).run(...args).changes
    json(res, { ok: true, deleted: count })
    return true
  }

  // POST /api/memories/ttl-sweep -- delete expired memories (called by heartbeat)
  if (path === '/api/memories/ttl-sweep' && method === 'POST') {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    const count = db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?').run(now).changes
    json(res, { ok: true, deleted: count })
    return true
  }

  // GET /api/data-policy -- read current policy
  if (path === '/api/data-policy' && method === 'GET') {
    const { loadDataPolicy } = await import('../../data-gate.js')
    json(res, loadDataPolicy())
    return true
  }

  // POST /api/data-policy/reload -- reload policy from disk
  if (path === '/api/data-policy/reload' && method === 'POST') {
    const { reloadDataPolicy } = await import('../../data-gate.js')
    reloadDataPolicy()
    json(res, { ok: true })
    return true
  }

  // GET /api/data-policy/audit -- outbound audit log (what left, when, why)
  // Query params: limit (1-1000, default 100), allowed (true|false),
  //   purpose (exact match), since (unix seconds)
  if (path === '/api/data-policy/audit' && method === 'GET') {
    const limitParamRaw = url.searchParams.get('limit')
    const allowedParam = url.searchParams.get('allowed')
    const purposeParam = url.searchParams.get('purpose')
    const sinceParam = url.searchParams.get('since')
    const rows = getOutboundAudit({
      limit: limitParamRaw ? parseInt(limitParamRaw, 10) : undefined,
      allowed: allowedParam == null ? undefined : allowedParam === 'true',
      purpose: purposeParam || undefined,
      since: sinceParam ? parseInt(sinceParam, 10) : undefined,
    })
    json(res, { stats: getOutboundAuditStats(), entries: rows })
    return true
  }

  const memUpdateMatch = path.match(/^\/api\/memories\/(\d+)$/)
  if (memUpdateMatch && method === 'PUT') {
    const id = parseInt(memUpdateMatch[1], 10)
    const body = await readBody(req)
    const { content, category, tier, agent_id, keywords } = JSON.parse(body.toString()) as { content: string; category?: string; tier?: string; agent_id?: string; keywords?: string }
    if (updateMemory(id, content, tier || category, agent_id, keywords)) { json(res, { ok: true }); return true }
    json(res, { error: 'Memory not found' }, 404)
    return true
  }

  if (memUpdateMatch && method === 'DELETE') {
    const id = parseInt(memUpdateMatch[1], 10)
    const db2 = getDb()
    const changes = db2.prepare('DELETE FROM memories WHERE id = ?').run(id).changes
    if (changes > 0) { json(res, { ok: true }); return true }
    json(res, { error: 'Memory not found' }, 404)
    return true
  }

  return false
}
