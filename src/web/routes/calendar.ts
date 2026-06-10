import { getDb } from '../../db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

function isoDate(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`
}

export async function tryHandleCalendar(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/calendar' && method === 'GET') {
    const now   = new Date()
    const year  = parseInt(url.searchParams.get('year')  ?? String(now.getFullYear()), 10)
    const month = parseInt(url.searchParams.get('month') ?? String(now.getMonth() + 1), 10)
    const mode  = url.searchParams.get('mode') ?? 'week'   // 'week' | 'month'

    let from: string, to: string

    if (mode === 'week') {
      // ISO week: Mon..Sun containing the given year/month/day (or today if day absent)
      const day = parseInt(url.searchParams.get('day') ?? String(now.getDate()), 10)
      const d   = new Date(year, month - 1, day)
      const dow = d.getDay() === 0 ? 7 : d.getDay() // 1=Mon
      const mon = new Date(d); mon.setDate(d.getDate() - (dow - 1))
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
      from = isoDate(mon.getFullYear(), mon.getMonth()+1, mon.getDate())
      to   = isoDate(sun.getFullYear(), sun.getMonth()+1, sun.getDate() + 1)
    } else {
      from = isoDate(year, month, 1)
      const toY = month === 12 ? year + 1 : year
      const toM = month === 12 ? 1 : month + 1
      to   = isoDate(toY, toM, 1)
    }

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

    const byDate: Record<string, typeof cards> = {}
    for (const c of cards) {
      if (!byDate[c.due_date]) byDate[c.due_date] = []
      byDate[c.due_date].push(c)
    }

    json(res, { year, month, mode, from, byDate })
    return true
  }

  return false
}
