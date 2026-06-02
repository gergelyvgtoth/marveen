import { MAIN_AGENT_ID } from '../../config.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { isSessionRunning } from '../agent-process.js'
import { getChannelHealth } from '../channel-health-monitor.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Self-health of the dashboard backend (the "npm start side") + the Telegram
// channel, for an at-a-glance dashboard widget. Motivated by repeated manual
// "restart the whole thing" episodes: the operator needs to SEE backend uptime
// (so a silent restart is visible) and channel liveness without digging.
export async function tryHandleHealth(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

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
