import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames } from './agent-config.js'
import { isAgentRunning, capturePane } from './agent-process.js'
import {
  attemptChannelMcpReconnect,
  resolveAgentSession,
  resolveAgentProviderType,
} from './channel-mcp-reconnect.js'
import { getProvider } from '../channel-provider.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { claimPendingOutbound, countPendingOutbound } from '../db.js'
import { buildResendPrompt } from './outbound-resend.js'
import { sendPromptToSession } from './agent-process.js'

// Detect `plugin:X · ✘ failed` (or ✘ error / ✘ disconnected) in the
// pane output. Claude Code renders this in the MCP status area when a
// channel plugin connection drops.
const PLUGIN_FAILED_RX = /✘\s*(?:failed|error|disconnected)/i

interface AgentReconnectState {
  attempts: number
  lastAttemptAt: number
  nextRetryAt: number
}

const BACKOFF_BASE_MS = 30_000
const BACKOFF_MULTIPLIER = 3
const MAX_RETRIES = 3
const COOLDOWN_MS = 30 * 60 * 1000

const reconnectState = new Map<string, AgentReconnectState>()

function getBackoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt)
}

function isPluginFailedInPane(pane: string, pluginPaneId: string): boolean {
  if (!pane.includes(pluginPaneId)) return false
  return PLUGIN_FAILED_RX.test(pane)
}

// After the channel is healthy again, hand any outbound messages that failed
// during the outage back to the agent so it can resend them via the reply tool.
// Best-effort: a tmux injection failure leaves the rows claimed (dispatched_at
// stamped) but still 'pending', so they surface in the dashboard rather than
// silently re-firing every tick.
function resendQueuedOutbound(agentName: string, session: string): void {
  if (countPendingOutbound(agentName) === 0) return
  const rows = claimPendingOutbound(agentName)
  if (rows.length === 0) return
  try {
    sendPromptToSession(session, buildResendPrompt(rows))
    logger.info({ agentName, count: rows.length }, 'channel-health-monitor: re-injected queued outbound for resend')
  } catch (err) {
    logger.warn({ err, agentName, count: rows.length }, 'channel-health-monitor: resend injection failed')
  }
}

export interface ChannelHealthStatus {
  healthy: boolean
  reconnectAttempts: number
  lastAttemptAt: number | null
}

export function getChannelHealth(agentName: string): ChannelHealthStatus {
  const state = reconnectState.get(agentName)
  if (!state) return { healthy: true, reconnectAttempts: 0, lastAttemptAt: null }
  return {
    healthy: false,
    reconnectAttempts: state.attempts,
    lastAttemptAt: state.lastAttemptAt,
  }
}

function checkAgent(agentName: string, session: string): void {
  const now = Date.now()
  const state = reconnectState.get(agentName)

  if (state && state.attempts >= MAX_RETRIES) {
    if (now - state.lastAttemptAt > COOLDOWN_MS) {
      reconnectState.delete(agentName)
    }
    return
  }

  if (state && now < state.nextRetryAt) return

  const pane = capturePane(session)
  if (!pane) return

  const providerType = resolveAgentProviderType(agentName)
  const provider = getProvider(providerType)

  if (!isPluginFailedInPane(pane, provider.pluginPaneId)) {
    if (state) {
      logger.info({ agentName, provider: providerType }, 'channel-health-monitor: plugin recovered')
      reconnectState.delete(agentName)
    }
    // Channel is healthy: flush any outbound lost during an outage. No-ops when
    // the queue is empty; claimed rows are stamped so this never re-fires them.
    resendQueuedOutbound(agentName, session)
    return
  }

  const attempt = state ? state.attempts : 0
  logger.warn(
    { agentName, attempt, provider: providerType },
    'channel-health-monitor: plugin failure detected, attempting reconnect',
  )

  const result = attemptChannelMcpReconnect(agentName)

  const backoffMs = getBackoffMs(attempt)
  reconnectState.set(agentName, {
    attempts: attempt + 1,
    lastAttemptAt: now,
    nextRetryAt: now + backoffMs,
  })

  if (result.ok) {
    logger.info({ agentName, attempt }, 'channel-health-monitor: reconnect succeeded')
  } else {
    logger.warn(
      { agentName, attempt, message: result.message },
      'channel-health-monitor: reconnect failed',
    )
  }
}

export function startChannelHealthMonitor(): NodeJS.Timeout {
  function check() {
    try {
      checkAgent(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.debug({ err }, 'channel-health-monitor: main agent check error')
    }

    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) continue
      try {
        checkAgent(name, resolveAgentSession(name))
      } catch (err) {
        logger.debug({ err, agent: name }, 'channel-health-monitor: agent check error')
      }
    }
  }

  // Offset from channel-monitor's 30s initial delay to avoid
  // overlapping tmux interactions on the same tick.
  setTimeout(check, 45_000)
  return setInterval(check, 60_000)
}
