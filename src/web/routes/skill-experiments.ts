import {
  createSkillExperiment, getActiveSkillExperiment, listSkillExperiments,
  assignSkillVariant, recordSkillVariantOutcome, getSkillExperimentResults,
  promoteSkillExperiment,
} from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleSkillExperiments(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // GET /api/skill-experiments -> list all
  if (path === '/api/skill-experiments' && method === 'GET') {
    json(res, listSkillExperiments())
    return true
  }

  // POST /api/skill-experiments { skill_name, variant_a, variant_b, hypothesis? }
  if (path === '/api/skill-experiments' && method === 'POST') {
    const body = await readBody(req)
    const d = JSON.parse(body.toString()) as { skill_name?: string; variant_a?: string; variant_b?: string; hypothesis?: string }
    if (!d.skill_name || !d.variant_a || !d.variant_b) { json(res, { error: 'skill_name, variant_a, variant_b kötelező' }, 400); return true }
    json(res, createSkillExperiment(d.skill_name, d.variant_a, d.variant_b, d.hypothesis))
    return true
  }

  // GET /api/skill-experiments/assignment?skill=NAME -> { variant: 'A'|'B'|null, experiment }
  if (path === '/api/skill-experiments/assignment' && method === 'GET') {
    const skill = url.searchParams.get('skill') || ''
    json(res, { variant: assignSkillVariant(skill), experiment: getActiveSkillExperiment(skill) ?? null })
    return true
  }

  // POST /api/skill-experiments/record { skill_name, variant, outcome, trigger_text?, note? }
  if (path === '/api/skill-experiments/record' && method === 'POST') {
    const body = await readBody(req)
    const d = JSON.parse(body.toString()) as { skill_name?: string; variant?: 'A' | 'B'; outcome?: 'positive' | 'negative' | 'neutral'; trigger_text?: string; note?: string }
    if (!d.skill_name || (d.variant !== 'A' && d.variant !== 'B') || !d.outcome) { json(res, { error: 'skill_name, variant(A|B), outcome kötelező' }, 400); return true }
    const id = recordSkillVariantOutcome(d.skill_name, d.variant, d.outcome, d.trigger_text, d.note)
    json(res, { ok: true, id })
    return true
  }

  // GET /api/skill-experiments/:id/results
  const resultsMatch = path.match(/^\/api\/skill-experiments\/(\d+)\/results$/)
  if (resultsMatch && method === 'GET') {
    const r = getSkillExperimentResults(parseInt(resultsMatch[1], 10))
    if (!r) { json(res, { error: 'Kísérlet nem található' }, 404); return true }
    json(res, r)
    return true
  }

  // POST /api/skill-experiments/:id/promote { winner: 'A'|'B' }
  const promoteMatch = path.match(/^\/api\/skill-experiments\/(\d+)\/promote$/)
  if (promoteMatch && method === 'POST') {
    const body = await readBody(req)
    const d = JSON.parse(body.toString()) as { winner?: 'A' | 'B' }
    if (d.winner !== 'A' && d.winner !== 'B') { json(res, { error: "winner 'A' vagy 'B'" }, 400); return true }
    if (promoteSkillExperiment(parseInt(promoteMatch[1], 10), d.winner)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kísérlet nem található' }, 404)
    return true
  }

  return false
}
