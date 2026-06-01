import {
  saveSessionRecording, listSessionRecordings, getSessionRecording,
  getBaselineRecording, deleteSessionRecording,
} from '../../db.js'
import { compareRecordings, type SessionRecording, type SessionEvent } from '../../session-replay.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

function toRecording(row: { name: string; scenario: string; events_json: string; id: number }): SessionRecording {
  let events: SessionEvent[] = []
  try { events = JSON.parse(row.events_json) } catch { events = [] }
  return { id: row.id, name: row.name, scenario: row.scenario, events }
}

export async function tryHandleSessionRecordings(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // GET /api/session-recordings?scenario=
  if (path === '/api/session-recordings' && method === 'GET') {
    const scenario = url.searchParams.get('scenario') || undefined
    const rows = listSessionRecordings(scenario).map(r => ({
      id: r.id, name: r.name, scenario: r.scenario, is_baseline: !!r.is_baseline,
      created_at: r.created_at, event_count: (() => { try { return JSON.parse(r.events_json).length } catch { return 0 } })(),
    }))
    json(res, rows)
    return true
  }

  // POST /api/session-recordings { name, scenario, events[], is_baseline? }
  if (path === '/api/session-recordings' && method === 'POST') {
    const body = await readBody(req)
    const d = JSON.parse(body.toString()) as { name?: string; scenario?: string; events?: unknown[]; is_baseline?: boolean }
    if (!d.name || !d.scenario || !Array.isArray(d.events)) { json(res, { error: 'name, scenario, events[] kötelező' }, 400); return true }
    json(res, saveSessionRecording(d.name, d.scenario, d.events, !!d.is_baseline))
    return true
  }

  // POST /api/session-recordings/compare { baselineId?, candidateId, scenario? }
  // If baselineId omitted, uses the scenario's baseline recording.
  if (path === '/api/session-recordings/compare' && method === 'POST') {
    const body = await readBody(req)
    const d = JSON.parse(body.toString()) as { baselineId?: number; candidateId?: number; scenario?: string }
    if (!d.candidateId) { json(res, { error: 'candidateId kötelező' }, 400); return true }
    const candRow = getSessionRecording(d.candidateId)
    if (!candRow) { json(res, { error: 'candidate nem található' }, 404); return true }
    const baseRow = d.baselineId ? getSessionRecording(d.baselineId)
      : getBaselineRecording(d.scenario || candRow.scenario)
    if (!baseRow) { json(res, { error: 'baseline nem található (adj baselineId-t vagy jelölj baseline-t a szcenárióhoz)' }, 404); return true }
    json(res, { baseline: { id: baseRow.id, name: baseRow.name }, candidate: { id: candRow.id, name: candRow.name }, diff: compareRecordings(toRecording(baseRow), toRecording(candRow)) })
    return true
  }

  const idMatch = path.match(/^\/api\/session-recordings\/(\d+)$/)
  if (idMatch && method === 'GET') {
    const row = getSessionRecording(parseInt(idMatch[1], 10))
    if (!row) { json(res, { error: 'nem található' }, 404); return true }
    json(res, toRecording(row))
    return true
  }
  if (idMatch && method === 'DELETE') {
    if (deleteSessionRecording(parseInt(idMatch[1], 10))) { json(res, { ok: true }); return true }
    json(res, { error: 'nem található' }, 404)
    return true
  }

  return false
}
