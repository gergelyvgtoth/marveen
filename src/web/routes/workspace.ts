import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import {
  getDb,
  saveWorkspaceSession, finishWorkspaceSession, deleteWorkspaceSession, getAllWorkspaceSessions,
  type WorkspaceSessionRow,
} from '../../db.js'
import { json, readBody } from '../http-helpers.js'
import { resolveFromPath } from '../../platform.js'
import type { RouteContext } from './types.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude') ?? 'claude'

type SessionInfo = { session: string; started: number; prompt: string; model: string; promptFile: string; outputFile: string }
// In-memory cache for currently-active sessions (synced to SQLite)
const activeSessions = new Map<string, SessionInfo>()
// Finished sessions (still viewable until manually deleted)
const finishedSessions = new Map<string, { outputFile: string; promptFile: string; finishedAt: number }>()

// On startup: restore sessions from SQLite
function loadSessionsFromDb(): void {
  const rows = getAllWorkspaceSessions()
  for (const row of rows) {
    if (row.status === 'active') {
      if (tmuxAlive(row.session_name)) {
        activeSessions.set(row.id, {
          session: row.session_name, started: row.started_at, prompt: row.prompt,
          model: row.model, promptFile: row.prompt_file, outputFile: row.output_file,
        })
      } else {
        // Was active but tmux session gone -- mark as finished
        finishWorkspaceSession(row.id)
        finishedSessions.set(row.id, { outputFile: row.output_file, promptFile: row.prompt_file, finishedAt: row.finished_at ?? Date.now() })
      }
    } else {
      finishedSessions.set(row.id, { outputFile: row.output_file, promptFile: row.prompt_file, finishedAt: row.finished_at ?? 0 })
    }
  }
}
loadSessionsFromDb()

function tmuxAlive(session: string): boolean {
  try { execFileSync(TMUX, ['has-session', '-t', session], { timeout: 3000, stdio: 'ignore' }); return true }
  catch { return false }
}

function tmuxCapture(session: string): string {
  try {
    const buf = execFileSync(TMUX, ['capture-pane', '-p', '-t', session], { timeout: 3000 })
    return buf.toString()
  } catch { return '' }
}

function skillContent(skillName: string): string {
  const paths = [
    `${process.env.HOME}/.claude/skills/${skillName}/SKILL.md`,
    `.claude/skills/${skillName}/SKILL.md`,
  ]
  for (const p of paths) {
    if (existsSync(p)) return readFileSync(p, 'utf8').slice(0, 2000)
  }
  return ''
}

export async function tryHandleWorkspace(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // GET /api/workspace/context -- memóriák + skill nevek a picker-hez
  if (path === '/api/workspace/context' && method === 'GET') {
    const db = getDb()
    const agent = url.searchParams.get('agent') ?? 'marveen'
    const memories = db.prepare(
      `SELECT id, content, category, keywords FROM memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT 60`
    ).all(agent) as { id: number; content: string; category: string; keywords: string | null }[]

    // Skills from ~/.claude/skills
    const skillsDir = `${process.env.HOME}/.claude/skills`
    let skills: { name: string; description: string }[] = []
    if (existsSync(skillsDir)) {
      const entries = execFileSync('ls', [skillsDir]).toString().trim().split('\n').filter(Boolean)
      skills = entries.map(name => {
        const p = `${skillsDir}/${name}/SKILL.md`
        if (!existsSync(p)) return null
        const desc = readFileSync(p, 'utf8').match(/^description:\s*(.+)$/m)?.[1] ?? ''
        return { name, description: desc }
      }).filter(Boolean) as { name: string; description: string }[]
    }

    json(res, { memories, skills })
    return true
  }

  // GET /api/workspace/sessions -- aktív + kész session-ök
  if (path === '/api/workspace/sessions' && method === 'GET') {
    const sessions = []
    // Active sessions: check tmux liveness
    for (const [id, s] of activeSessions.entries()) {
      const alive = tmuxAlive(s.session)
      if (!alive) {
        const now = Date.now()
        finishedSessions.set(id, { outputFile: s.outputFile, promptFile: s.promptFile, finishedAt: now })
        finishWorkspaceSession(id)
        activeSessions.delete(id)
        sessions.push({ id, prompt: s.prompt.slice(0, 80), model: s.model, started: s.started, alive: false })
        continue
      }
      sessions.push({ id, session: s.session, started: s.started, prompt: s.prompt.slice(0, 80), model: s.model, alive: true })
    }
    // Finished sessions
    for (const [id, f] of finishedSessions.entries()) {
      if (sessions.find(s => s.id === id)) continue
      // Rebuild prompt from DB for finished sessions
      const dbRow = getAllWorkspaceSessions().find(r => r.id === id)
      sessions.push({ id, prompt: (dbRow?.prompt ?? '').slice(0, 80), model: dbRow?.model ?? '', started: dbRow?.started_at ?? 0, alive: false })
    }
    // Sort by started desc
    sessions.sort((a, b) => b.started - a.started)
    json(res, { sessions })
    return true
  }

  // GET /api/workspace/sessions/:id/stream -- SSE live output
  const streamMatch = path.match(/^\/api\/workspace\/sessions\/([^/]+)\/stream$/)
  if (streamMatch && method === 'GET') {
    const id = streamMatch[1]
    const s = activeSessions.get(id)
    // Also serve completed sessions from finishedSessions
    if (!s) {
      const fin = finishedSessions.get(id)
      if (!fin) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return true }
      // One-shot: serve the final output and close
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      const pane = existsSync(fin.outputFile) ? readFileSync(fin.outputFile, 'utf8') : ''
      res.write(`data: ${JSON.stringify({ pane, alive: false })}\n\n`)
      res.end()
      return true
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    let closed = false
    const tick = (): void => {
      if (closed) return
      const pane = existsSync(s.outputFile) ? readFileSync(s.outputFile, 'utf8') : ''
      const alive = tmuxAlive(s.session)
      if (!alive) {
        activeSessions.delete(id)
        const now = Date.now()
        finishedSessions.set(id, { outputFile: s.outputFile, promptFile: s.promptFile, finishedAt: now })
        finishWorkspaceSession(id)
      }
      try {
        res.write(`data: ${JSON.stringify({ pane, alive })}\n\n`)
      } catch { closed = true }
      if (!alive) { closed = true; try { res.end() } catch {} }
    }

    tick()
    const interval = setInterval(tick, 700)
    const stop = (): void => { closed = true; clearInterval(interval) }
    ctx.req.on('close', stop)
    ctx.req.on('error', stop)
    return true
  }

  // GET /api/workspace/sessions/:id/output -- snapshot output
  const outputMatch = path.match(/^\/api\/workspace\/sessions\/([^/]+)\/output$/)
  if (outputMatch && method === 'GET') {
    const id = outputMatch[1]
    const s = activeSessions.get(id)
    if (!s) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return true }
    const output = existsSync(s.outputFile) ? readFileSync(s.outputFile, 'utf8') : ''
    json(res, { id, output, alive: tmuxAlive(s.session) })
    return true
  }

  // DELETE /api/workspace/sessions/:id
  const delMatch = path.match(/^\/api\/workspace\/sessions\/([^/]+)$/)
  if (delMatch && method === 'DELETE') {
    const id = delMatch[1]
    const s = activeSessions.get(id)
    if (s) {
      try { execFileSync(TMUX, ['kill-session', '-t', s.session]) } catch {}
      try { unlinkSync(s.promptFile) } catch {}
      try { unlinkSync(s.outputFile) } catch {}
      activeSessions.delete(id)
    }
    const fin = finishedSessions.get(id)
    if (fin) {
      try { unlinkSync(fin.outputFile) } catch {}
      try { unlinkSync(fin.promptFile) } catch {}
      finishedSessions.delete(id)
    }
    deleteWorkspaceSession(id)
    json(res, { ok: true })
    return true
  }

  // POST /api/workspace/launch
  if (path === '/api/workspace/launch' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString()) as {
      prompt: string
      model?: string
      plan?: boolean
      memories?: number[]
      skills?: string[]
    }

    if (!body.prompt?.trim()) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'prompt required' })); return true
    }

    const db = getDb()
    const model = body.model ?? 'claude-sonnet-4-6'
    const plan = body.plan ?? false

    // Build context prefix from selected memories + skills
    const parts: string[] = []
    if (body.memories?.length) {
      const placeholders = body.memories.map(() => '?').join(',')
      const rows = db.prepare(`SELECT content FROM memories WHERE id IN (${placeholders})`).all(...body.memories) as { content: string }[]
      if (rows.length) {
        parts.push('## Context from memory\n' + rows.map(r => `- ${r.content}`).join('\n'))
      }
    }
    if (body.skills?.length) {
      for (const name of body.skills) {
        const content = skillContent(name)
        if (content) parts.push(`## Skill: ${name}\n${content}`)
      }
    }

    const fullPrompt = parts.length
      ? parts.join('\n\n') + '\n\n---\n\n' + body.prompt
      : body.prompt

    const id = randomUUID().slice(0, 8)
    const sessionName = `workspace-${id}`
    const promptFile = `/tmp/ws-prompt-${id}.txt`
    const outputFile = `/tmp/ws-out-${id}.txt`

    // Write prompt to file to avoid shell quoting issues with complex prompts
    writeFileSync(promptFile, fullPrompt)

    // Run claude in tmux wrapping output to file; -p flag = non-interactive print mode
    // Quotes around $(cat) are essential -- without them the shell word-splits the prompt
    const planFlag = plan ? ' --plan' : ''
    const shellCmd = `${CLAUDE} --model ${model}${planFlag} -p "$(cat ${promptFile})" > ${outputFile} 2>&1`
    const args = ['new-session', '-d', '-s', sessionName, 'sh', '-c', shellCmd]

    try {
      execFileSync(TMUX, args, { timeout: 10000 })
      const startedAt = Date.now()
      activeSessions.set(id, { session: sessionName, started: startedAt, prompt: body.prompt, model, promptFile, outputFile })
      saveWorkspaceSession(id, sessionName, body.prompt, model, promptFile, outputFile, startedAt)
      json(res, { ok: true, id, session: sessionName })
    } catch (err) {
      try { unlinkSync(promptFile) } catch {}
      res.writeHead(500)
      res.end(JSON.stringify({ error: String(err) }))
    }
    return true
  }

  return false
}
