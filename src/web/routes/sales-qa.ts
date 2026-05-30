import { randomUUID } from 'node:crypto'
import { listSalesQA, createSalesQA, updateSalesQA, deleteSalesQA, recordSalesQAUsage } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import { maskPII } from '../../pii-filter.js'
import type { RouteContext } from './types.js'

export async function tryHandleSalesQA(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // GET /api/sales-qa?q=...&tag=...&limit=...
  if (path === '/api/sales-qa' && method === 'GET') {
    const q = url.searchParams.get('q') || undefined
    const tag = url.searchParams.get('tag') || undefined
    const limit = parseInt(url.searchParams.get('limit') || '50')
    json(res, listSalesQA({ q, tag, limit }))
    return true
  }

  // POST /api/sales-qa
  if (path === '/api/sales-qa' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      question: string
      answer: string
      context?: string
      tags?: string
      source?: string
    }
    if (!data.question?.trim()) { json(res, { error: 'question required' }, 400); return true }
    if (!data.answer?.trim()) { json(res, { error: 'answer required' }, 400); return true }
    const id = randomUUID().slice(0, 8)
    createSalesQA({
      id,
      question: maskPII(data.question.trim()),
      answer: maskPII(data.answer.trim()),
      context: data.context ? maskPII(data.context.trim()) : null,
      tags: data.tags?.trim() ?? '',
      source: data.source ?? 'manual',
    })
    json(res, { ok: true, id })
    return true
  }

  const match = path.match(/^\/api\/sales-qa\/([^/]+)$/)

  // PUT /api/sales-qa/:id
  if (match && method === 'PUT') {
    const id = decodeURIComponent(match[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    if (updateSalesQA(id, data)) { json(res, { ok: true }); return true }
    json(res, { error: 'Nem található' }, 404)
    return true
  }

  // DELETE /api/sales-qa/:id
  if (match && method === 'DELETE') {
    const id = decodeURIComponent(match[1])
    if (deleteSalesQA(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Nem található' }, 404)
    return true
  }

  // POST /api/sales-qa/:id/use  -- increment usage counter
  const useMatch = path.match(/^\/api\/sales-qa\/([^/]+)\/use$/)
  if (useMatch && method === 'POST') {
    recordSalesQAUsage(decodeURIComponent(useMatch[1]))
    json(res, { ok: true })
    return true
  }

  return false
}
