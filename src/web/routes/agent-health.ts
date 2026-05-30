import { execFileSync } from 'node:child_process'
import { json } from '../http-helpers.js'
import { listAgentNames } from '../agent-config.js'
import { isAgentRunning, getAgentRunningSince } from '../agent-process.js'
import { getDb } from '../../db.js'
import type { RouteContext } from './types.js'

const TMUX = 'tmux'

function getAgentPid(name: string): number | null {
  try {
    const sessionName = `marveen-${name}`
    const out = execFileSync(
      TMUX,
      ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'],
      { timeout: 3000, encoding: 'utf-8' },
    ).trim()
    const pid = parseInt(out, 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

function getPidStats(pid: number): { cpu: number; mem: number } | null {
  try {
    const out = execFileSync(
      'ps',
      ['--no-headers', '-p', String(pid), '-o', '%cpu,%mem'],
      { timeout: 3000, encoding: 'utf-8' },
    ).trim()
    const parts = out.split(/\s+/)
    if (parts.length < 2) return null
    return { cpu: parseFloat(parts[0]), mem: parseFloat(parts[1]) }
  } catch {
    return null
  }
}

function getLastActivity(agentName: string): number | null {
  try {
    const db = getDb()
    const row = db.prepare(
      `SELECT created_at FROM tool_call_log
       WHERE session_id LIKE ? ORDER BY created_at DESC LIMIT 1`
    ).get(`%${agentName}%`) as { created_at: number } | undefined
    return row?.created_at ?? null
  } catch {
    return null
  }
}

export async function tryHandleAgentHealth(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/agent-health' && method === 'GET') {
    const agents = listAgentNames()
    const now = Math.floor(Date.now() / 1000)

    const health = agents.map(name => {
      const running = isAgentRunning(name)
      const runningSince = running ? getAgentRunningSince(name) : null
      const uptimeSec = runningSince ? now - runningSince : null
      const pid = running ? getAgentPid(name) : null
      const stats = pid ? getPidStats(pid) : null
      const lastActivity = getLastActivity(name)
      const idleSec = lastActivity ? now - lastActivity : null

      return {
        name,
        running,
        runningSince,
        uptimeSec,
        pid,
        cpu: stats?.cpu ?? null,
        mem: stats?.mem ?? null,
        lastActivity,
        idleSec,
        status: !running ? 'stopped' : idleSec !== null && idleSec > 600 ? 'idle' : 'active',
      }
    })

    json(res, { agents: health, timestamp: now })
    return true
  }

  return false
}
