import { execSync } from 'node:child_process'
import { MAIN_AGENT_ID } from '../../config.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { isSessionRunning } from '../agent-process.js'
import { getChannelHealth } from '../channel-health-monitor.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

interface WatchdogStatus {
  name: string
  active: boolean
  lastRunAt: number | null   // ms epoch
  nextRunAt: number | null   // ms epoch
  lastResult: string | null  // 'success' | 'failed' | null
}

function parseSystemdDate(val: string): number | null {
  // systemd --user show returns human-readable: "Wed 2026-06-10 21:59:07 CEST"
  // Strip the weekday prefix and trailing timezone, then parse.
  if (!val || val === 'n/a') return null
  const m = val.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
  if (!m) return null
  const ms = Date.parse(m[0])
  return isNaN(ms) ? null : ms
}

function parseMonotonicOffset(val: string): number | null {
  // e.g. "1h 33min 33.009977s" -- convert to future ms from now
  if (!val || val === 'n/a') return null
  let total = 0
  const h = val.match(/(\d+)h/)
  const m = val.match(/(\d+)min/)
  const s = val.match(/([\d.]+)s/)
  if (h) total += parseInt(h[1]) * 3600000
  if (m) total += parseInt(m[1]) * 60000
  if (s) total += parseFloat(s[1]) * 1000
  return total > 0 ? Date.now() + total : null
}

function queryTimer(timerUnit: string): WatchdogStatus {
  const name = timerUnit.replace('.timer', '')
  try {
    const uid = process.getuid?.() ?? 1000
    const env = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${uid}` }
    const raw = execSync(
      `systemctl --user show ${timerUnit} --property=ActiveState,LastTriggerUSec,NextElapseUSecRealtime,NextElapseUSecMonotonic`,
      { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 }
    )
    const props: Record<string, string> = {}
    for (const line of raw.trim().split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1)
    }
    const active = props['ActiveState'] === 'active'
    const lastRunAt = parseSystemdDate(props['LastTriggerUSec'] ?? '')
    // NextElapseUSecRealtime is empty for monotonic timers; fall back to monotonic offset
    const nextRunAt = parseSystemdDate(props['NextElapseUSecRealtime'] ?? '')
      ?? parseMonotonicOffset(props['NextElapseUSecMonotonic'] ?? '')
    let lastResult: string | null = null
    try {
      const svcRaw = execSync(
        `systemctl --user show ${name}.service --property=Result`,
        { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }
      )
      const r = svcRaw.trim().split('=')[1] ?? ''
      lastResult = r === 'success' ? 'success' : r || null
    } catch { /* service may not exist separately */ }
    return { name, active, lastRunAt, nextRunAt, lastResult }
  } catch {
    return { name, active: false, lastRunAt: null, nextRunAt: null, lastResult: null }
  }
}

// Self-health of the dashboard backend (the "npm start side") + the Telegram
// channel, for an at-a-glance dashboard widget. Motivated by repeated manual
// "restart the whole thing" episodes: the operator needs to SEE backend uptime
// (so a silent restart is visible) and channel liveness without digging.
export async function tryHandleHealth(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/watchdog-status' && method === 'GET') {
    json(res, {
      watchdogs: [
        queryTimer('channel-watchdog.timer'),
        queryTimer('marveen-fleet-watchdog.timer'),
      ],
      timestamp: Date.now(),
    })
    return true
  }

  if (path === '/api/health' && method === 'GET') {
    const uptimeSec = Math.floor(process.uptime())
    const nowMs = Date.now()
    const channel = getChannelHealth(MAIN_AGENT_ID)
    const sessionAlive = isSessionRunning(MAIN_CHANNELS_SESSION)

    json(res, {
      // "npm start side": the node dist/index.js process serving this dashboard.
      backend: {
        pid: process.pid,
        uptimeSec,
        startedAt: nowMs - uptimeSec * 1000,
      },
      // Telegram side: channel-health-monitor reconnect state + whether the main
      // channels tmux session is even alive.
      channel: {
        sessionAlive,
        healthy: channel.healthy && sessionAlive,
        reconnectAttempts: channel.reconnectAttempts,
        lastAttemptAt: channel.lastAttemptAt,
      },
      timestamp: nowMs,
    })
    return true
  }

  return false
}
