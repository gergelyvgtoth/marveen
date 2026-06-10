import { execSync } from 'node:child_process'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../../config.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { isSessionRunning } from '../agent-process.js'
import { getChannelHealth } from '../channel-health-monitor.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

interface WatchdogStatus {
  name: string
  label: string
  description: string        // what this watchdog guards
  scheduler: 'systemd' | 'cron'
  schedule: string           // human-readable interval
  active: boolean
  lastRunAt: number | null   // ms epoch
  nextRunAt: number | null   // ms epoch
  lastResult: string | null  // 'success' | 'failed' | null
  recentLog: string[]        // last N log lines
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

function readLogTail(logPath: string, lines = 8): string[] {
  if (!existsSync(logPath)) return []
  try {
    const content = readFileSync(logPath, 'utf8')
    return content.trim().split('\n').slice(-lines).filter(Boolean)
  } catch { return [] }
}

const WATCHDOG_META: Record<string, { label: string; description: string; schedule: string }> = {
  'channel-watchdog': {
    label: 'Csatorna watchdog',
    description: 'Telegram/Slack plugin-kapcsolat ellenőrzése. Ha a csatorna néma vagy a bot-process megáll, riaszt és újraindítja.',
    schedule: '5 percenként',
  },
  'marveen-fleet-watchdog': {
    label: 'Fleet watchdog',
    description: 'Az összes al-ágens (agrolanc, coder, mutacsi, tanulo) tmux-session állapotát figyeli. Leállt agenst automatikusan újraindítja.',
    schedule: '5 percenként',
  },
  'watchdog-cron': {
    label: 'Backend watchdog',
    description: 'A dashboard backend (port 3420) élőségét ellenőrzi /api/health probe-bal. Ha nem válaszol, megöli a zombi-processt és újraindítja.',
    schedule: '30 percenként (cron)',
  },
}

function queryTimer(timerUnit: string, logPath?: string): WatchdogStatus {
  const name = timerUnit.replace('.timer', '')
  const meta = WATCHDOG_META[name] ?? { label: name, description: '', schedule: '?' }
  const recentLog = logPath ? readLogTail(logPath) : []
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
    return {
      name, label: meta.label, description: meta.description,
      scheduler: 'systemd', schedule: meta.schedule,
      active, lastRunAt, nextRunAt, lastResult, recentLog,
    }
  } catch {
    return {
      name, label: meta.label, description: meta.description,
      scheduler: 'systemd', schedule: meta.schedule,
      active: false, lastRunAt: null, nextRunAt: null, lastResult: null, recentLog,
    }
  }
}

function queryCronWatchdog(logPath: string): WatchdogStatus {
  const meta = WATCHDOG_META['watchdog-cron']!
  const recentLog = readLogTail(logPath)
  // Derive last run from log file mtime (cron doesn't give us a timer API)
  let lastRunAt: number | null = null
  try { lastRunAt = statSync(logPath).mtimeMs } catch { /* no log yet */ }
  // Next run: 30min after last run (cron */30)
  const nextRunAt = lastRunAt ? lastRunAt + 30 * 60 * 1000 : null
  // Detect failures: last log line contains 'unhealthy' or 'failed'
  const lastLine = recentLog[recentLog.length - 1] ?? ''
  const lastResult = lastLine.includes('unhealthy') || lastLine.includes('FAIL')
    ? 'failed' : recentLog.length > 0 ? 'success' : null
  return {
    name: 'watchdog-cron', label: meta.label, description: meta.description,
    scheduler: 'cron', schedule: meta.schedule,
    active: existsSync(logPath),
    lastRunAt, nextRunAt, lastResult, recentLog,
  }
}

// Self-health of the dashboard backend (the "npm start side") + the Telegram
// channel, for an at-a-glance dashboard widget. Motivated by repeated manual
// "restart the whole thing" episodes: the operator needs to SEE backend uptime
// (so a silent restart is visible) and channel liveness without digging.
export async function tryHandleHealth(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/watchdog-status' && method === 'GET') {
    const logDir = join(process.cwd(), 'logs')
    json(res, {
      watchdogs: [
        queryCronWatchdog(join(logDir, 'watchdog.log')),
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
