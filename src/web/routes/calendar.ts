import { getDb } from '../../db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleCalendar(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/calendar' && method === 'GET') {
    const year  = parseInt(url.searchParams.get('year')  ?? String(new Date().getFullYear()), 10)
    const month = parseInt(url.searchParams.get('month') ?? String(new Date().getMonth() + 1), 10)

    // date range: first..last day of month (ISO strings for LIKE comparison)
    const from = `${year}-${String(month).padStart(2, '0')}-01`
    const toY  = month === 12 ? year + 1 : year
    const toM  = month === 12 ? 1 : month + 1
    const to   = `${toY}-${String(toM).padStart(2, '0')}-01`

    const db = getDb()
    const cards = db.prepare(`
      SELECT id, title, status, priority, project, due_date, assignee
      FROM kanban_cards
      WHERE due_date IS NOT NULL
        AND due_date >= ?
        AND due_date < ?
        AND archived_at IS NULL
      ORDER BY due_date ASC, priority DESC
    `).all(from, to) as {
      id: string; title: string; status: string; priority: string;
      project: string | null; due_date: string; assignee: string | null
    }[]

    // group by date
    const byDate: Record<string, typeof cards> = {}
    for (const c of cards) {
      if (!byDate[c.due_date]) byDate[c.due_date] = []
      byDate[c.due_date].push(c)
    }

    json(res, { year, month, byDate })
    return true
  }

  return false
}
