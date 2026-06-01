import { getDb } from '../../db.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { computeOpportunities, type ScoredMemory } from '../../sales-opportunities.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleSalesOpportunities(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  // GET /api/sales/opportunities?agent=marveen&limit=10
  if (path === '/api/sales/opportunities' && method === 'GET') {
    const agentId = url.searchParams.get('agent') || MAIN_AGENT_ID
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10', 10), 1), 50)
    const db = getDb()
    const rows = db.prepare(
      `SELECT id, content, keywords, created_at FROM memories
       WHERE (agent_id = ? OR category = 'shared') ORDER BY created_at DESC LIMIT 500`
    ).all(agentId) as ScoredMemory[]
    const nowTs = Math.floor(Date.now() / 1000)
    const opportunities = computeOpportunities(rows, nowTs).slice(0, limit)
    json(res, { opportunities })
    return true
  }

  return false
}
