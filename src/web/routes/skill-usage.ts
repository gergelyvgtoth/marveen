import { logSkillUsage, updateSkillUsageOutcome, getSkillUsageStats, getNegativeSkillFeedback } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleSkillUsage(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/skill-usage -- log a skill execution
  if (path === '/api/skill-usage' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { skill_name: string; agent_id?: string; trigger_text?: string }
    if (!data.skill_name) { json(res, { error: 'skill_name required' }, 400); return true }
    const id = logSkillUsage(data.skill_name, data.agent_id ?? 'marveen', data.trigger_text)
    json(res, { ok: true, id })
    return true
  }

  // PUT /api/skill-usage/:id -- update outcome (positive/negative + optional note)
  const match = path.match(/^\/api\/skill-usage\/(\d+)$/)
  if (match && method === 'PUT') {
    const id = parseInt(match[1], 10)
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { outcome: 'positive' | 'negative'; note?: string }
    if (!['positive', 'negative'].includes(data.outcome)) { json(res, { error: 'outcome must be positive or negative' }, 400); return true }
    if (updateSkillUsageOutcome(id, data.outcome, data.note)) { json(res, { ok: true }); return true }
    json(res, { error: 'Nem található' }, 404)
    return true
  }

  // GET /api/skill-usage/stats?since=<unix> -- aggregated stats
  if (path === '/api/skill-usage/stats' && method === 'GET') {
    const since = url.searchParams.get('since') ? parseInt(url.searchParams.get('since')!) : undefined
    json(res, getSkillUsageStats(since))
    return true
  }

  // GET /api/skill-usage/negative/:skill_name -- negative feedback for a skill
  const negMatch = path.match(/^\/api\/skill-usage\/negative\/(.+)$/)
  if (negMatch && method === 'GET') {
    const skillName = decodeURIComponent(negMatch[1])
    json(res, getNegativeSkillFeedback(skillName))
    return true
  }

  return false
}
