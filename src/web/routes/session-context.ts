import {
  saveSessionContext,
  getLatestSessionContext,
  pruneSessionContexts,
  hybridSearch,
  getDb,
} from '../../db.js'
import { filterOutbound } from '../../data-gate.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleSessionContext(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // GET /api/session-context/latest?agent=marveen&limit=3
  if (path === '/api/session-context/latest' && method === 'GET') {
    const agent = url.searchParams.get('agent') || 'marveen'
    const limit = parseInt(url.searchParams.get('limit') || '1')
    const rows = getLatestSessionContext(agent, limit)
    json(res, rows.map(r => ({
      ...r,
      top_memories: safeJson(r.top_memories_json, []),
      kanban_snapshot: safeJson(r.kanban_snapshot_json, []),
      open_decisions: safeJson(r.open_decisions_json, []),
    })))
    return true
  }

  // POST /api/session-context/snapshot -- build and save a fresh context snapshot
  if (path === '/api/session-context/snapshot' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      agent_id?: string
      query?: string
      memory_limit?: number
    }
    const agentId = data.agent_id || 'marveen'
    const query = data.query || 'aktuális feladatok döntések folyamatban'
    const memLimit = data.memory_limit || 8

    // Top memories via hybrid search -- filtered through outbound gate
    let topMemories: unknown[] = []
    try {
      const mems = await hybridSearch(agentId, query, memLimit * 2)
      const filtered = filterOutbound(
        mems.map(m => ({ ...m, id: m.id })),
        'session-context-snapshot'
      )
      topMemories = filtered.slice(0, memLimit).map(m => ({
        id: m.id,
        content: m.content.slice(0, 300),
        category: m.category,
        keywords: m.keywords,
      }))
    } catch { /* Ollama not running, fallback to empty */ }

    // Kanban in_progress + waiting (not archived)
    const db = getDb()
    const kanbanSnapshot = db.prepare(
      `SELECT id, title, status, assignee, priority, description
       FROM kanban_cards
       WHERE status IN ('in_progress', 'waiting') AND archived_at IS NULL
       ORDER BY CASE status WHEN 'in_progress' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 15`
    ).all()

    // Hot-tier memories as "open decisions"
    const openDecisions = db.prepare(
      `SELECT id, content, keywords, created_at
       FROM memories
       WHERE agent_id = ? AND category = 'hot'
       ORDER BY created_at DESC LIMIT 10`
    ).all(agentId)

    const id = saveSessionContext(agentId, {
      topMemories,
      kanbanSnapshot,
      openDecisions,
    })

    pruneSessionContexts(agentId, 10)

    json(res, {
      ok: true,
      id,
      memory_count: topMemories.length,
      kanban_count: (kanbanSnapshot as unknown[]).length,
      decisions_count: (openDecisions as unknown[]).length,
    })
    return true
  }

  // DELETE /api/session-context/prune?agent=marveen&keep=10
  if (path === '/api/session-context/prune' && method === 'DELETE') {
    const agent = url.searchParams.get('agent') || 'marveen'
    const keep = parseInt(url.searchParams.get('keep') || '10')
    pruneSessionContexts(agent, keep)
    json(res, { ok: true })
    return true
  }

  return false
}

function safeJson(s: string, fallback: unknown): unknown {
  try { return JSON.parse(s) } catch { return fallback }
}
