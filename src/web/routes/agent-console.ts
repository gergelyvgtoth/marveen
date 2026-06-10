import { isSessionRunning, capturePane } from '../agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { renderAgentTranscript, searchAgentTranscript } from '../agent-transcript.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

interface AgentInfo {
  id: string
  displayName: string
  sessionName: string
  isRunning: boolean
}

const AGENT_INFO: Record<string, AgentInfo> = {
  marveen: {
    id: 'marveen',
    displayName: 'Marveen',
    sessionName: MAIN_CHANNELS_SESSION,
    isRunning: false,
  },
  agrolanc: {
    id: 'agrolanc',
    displayName: 'Sales Mariska',
    sessionName: 'agent-agrolanc',
    isRunning: false,
  },
  coder: {
    id: 'coder',
    displayName: 'Cody a kódmester',
    sessionName: 'agent-coder',
    isRunning: false,
  },
  mutacsi: {
    id: 'mutacsi',
    displayName: 'Műtacsi',
    sessionName: 'agent-mutacsi',
    isRunning: false,
  },
  tanulo: {
    id: 'tanulo',
    displayName: 'Tanító Tóni',
    sessionName: 'agent-tanulo',
    isRunning: false,
  },
}

function getSessionName(agentId: string): string | null {
  const info = AGENT_INFO[agentId]
  return info ? info.sessionName : null
}

function getAgentIdFromSessionName(sessionName: string): string | null {
  for (const [agentId, info] of Object.entries(AGENT_INFO)) {
    if (info.sessionName === sessionName) return agentId
  }
  return null
}

// How much scrollback the console serves per poll. tmux history is captured
// with -S -SCROLLBACK_LINES and trimmed to the same depth for display.
const SCROLLBACK_LINES = 2000

function getCaptureLines(output: string | null, lineCount: number = 50): string {
  if (!output) return '[no output]'
  const lines = output.split('\n')
  const lastLines = lines.slice(Math.max(0, lines.length - lineCount))
  return lastLines.join('\n')
}

export async function tryHandleAgentConsole(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // GET /api/transcript-search?q=...&agent=...&limit=...
  // Cross-agent forensic search over recent session transcripts. tmux keeps no
  // scrollback for the alternate-screen TUI, so this is the only way to ask
  // fleet-wide questions like "every EADDRINUSE this week".
  if (path === '/api/transcript-search' && method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').trim()
    const agentFilter = url.searchParams.get('agent') ?? ''
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '400', 10) || 400, 1), 2000)

    if (!query) {
      json(res, { query, count: 0, output: '[adj meg keresőszót]', agentsSearched: 0 })
      return true
    }

    const agentIds = agentFilter && AGENT_INFO[agentFilter]
      ? [agentFilter]
      : Object.keys(AGENT_INFO)

    const blocks: string[] = []
    let count = 0
    for (const agentId of agentIds) {
      if (count >= limit) break
      const matches = searchAgentTranscript(agentId, query, limit - count)
      if (!matches.length) continue
      count += matches.length
      blocks.push(`=== ${AGENT_INFO[agentId].displayName} (${AGENT_INFO[agentId].sessionName}) ===\n${matches.join('\n')}`)
    }

    json(res, {
      query,
      count,
      output: blocks.length ? blocks.join('\n\n') : `[nincs találat: "${query}"]`,
      agentsSearched: agentIds.length,
      truncated: count >= limit,
    })
    return true
  }

  // GET /api/agent-console/agents
  if (path === '/api/agent-console/agents' && method === 'GET') {
    const agents = Object.values(AGENT_INFO).map(info => ({
      id: info.id,
      displayName: info.displayName,
      sessionName: info.sessionName,
      isRunning: isSessionRunning(info.sessionName),
    }))
    json(res, agents)
    return true
  }

  // GET /api/agent-console/:session_name/transcript
  // Renders the agent's latest Claude Code session transcript (real scrollback;
  // tmux keeps none for the alternate-screen TUI -- see agent-transcript.ts).
  const transcriptMatch = path.match(/^\/api\/agent-console\/([^/]+)\/transcript$/)
  if (transcriptMatch && method === 'GET') {
    const sessionName = decodeURIComponent(transcriptMatch[1])
    const agentId = getAgentIdFromSessionName(sessionName)
    if (!agentId) {
      json(res, { error: `Unknown session: ${sessionName}` }, 404)
      return true
    }
    const result = renderAgentTranscript(agentId)
    json(res, {
      agentId,
      sessionName,
      found: result.found,
      file: result.file,
      output: result.text,
      lineCount: result.lineCount,
      lastUpdate: Date.now(),
    })
    return true
  }

  // GET /api/agent-console/:session_name
  const consoleMatch = path.match(/^\/api\/agent-console\/([^/]+)$/)
  if (consoleMatch && method === 'GET') {
    const sessionName = decodeURIComponent(consoleMatch[1])
    const agentId = getAgentIdFromSessionName(sessionName)

    if (!agentId) {
      json(res, { error: `Unknown session: ${sessionName}` }, 404)
      return true
    }

    const agentInfo = AGENT_INFO[agentId]
    const isRunning = isSessionRunning(agentInfo.sessionName)
    const rawOutput = isRunning ? capturePane(sessionName, SCROLLBACK_LINES) : null
    const output = getCaptureLines(rawOutput, SCROLLBACK_LINES)

    json(res, {
      agentId,
      sessionName,
      isRunning,
      output,
      lineCount: rawOutput ? rawOutput.split('\n').length : 0,
      lastUpdate: Date.now(),
    })
    return true
  }

  return false
}
