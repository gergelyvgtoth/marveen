import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { agentConfigRoot } from './agent-config.js'

// The agent console "Előzmény" (history) tab can't read scrollback from tmux:
// Claude Code is a full-screen alternate-screen TUI, so capture-pane keeps no
// history. The real conversation log lives in the Claude Code session
// transcript JSONL under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl. This
// module locates the latest transcript for an agent and renders it to a
// readable, scrollable, searchable plain-text log for the dashboard.

// Cap rendered lines so a multi-MB transcript can't blow up the response.
const MAX_RENDERED_LINES = 3000

function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

// Mirror Claude Code's own project-dir encoding: every `/` becomes `-`.
function encodedProjectDir(agentId: string): string {
  return agentConfigRoot(agentId).replace(/\//g, '-')
}

// All .jsonl transcript files for an agent, newest first.
function transcriptFiles(agentId: string): string[] {
  const dir = join(projectsRoot(), encodedProjectDir(agentId))
  if (!existsSync(dir)) return []
  const files: { path: string; mtime: number }[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    const path = join(dir, f)
    try { files.push({ path, mtime: statSync(path).mtimeMs }) } catch { /* skip */ }
  }
  return files.sort((a, b) => b.mtime - a.mtime).map(f => f.path)
}

function latestTranscriptFile(agentId: string): string | null {
  return transcriptFiles(agentId)[0] ?? null
}

function fmtTime(ts: unknown): string {
  if (typeof ts !== 'string') return '--:--'
  try {
    return new Date(ts).toLocaleTimeString('hu-HU', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Budapest',
    })
  } catch {
    return '--:--'
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function briefInput(input: unknown): string {
  try {
    return oneLine(typeof input === 'string' ? input : JSON.stringify(input))
  } catch {
    return ''
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b => (b && typeof b === 'object' && typeof (b as any).text === 'string' ? (b as any).text : ''))
      .join(' ')
  }
  return ''
}

export interface TranscriptResult {
  found: boolean
  file: string | null
  text: string
  lineCount: number
}

// Render the latest session transcript for an agent into readable lines:
//   [HH:MM] >> incoming prompt / channel message
//   [HH:MM] AI: assistant reply text
//   [HH:MM]    [tool] Name: brief input
//   [HH:MM]    [out]  brief tool result
// Thinking blocks and Claude Code bookkeeping entries (mode, system, ...) are
// dropped to keep the log scannable.
// Parse one transcript JSONL blob into readable lines (the rendering shared by
// the single-agent history view and the cross-agent forensic search).
function renderTranscriptLines(raw: string): string[] {
  const out: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    const ts = fmtTime(o.timestamp)

    if (o.type === 'user') {
      const c = o.message?.content
      if (typeof c === 'string') {
        out.push(`[${ts}] >> ${clip(oneLine(c), 2000)}`)
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'tool_result') {
            out.push(`[${ts}]    [out]  ${clip(oneLine(toolResultText(b.content)), 600)}`)
          }
        }
      }
    } else if (o.type === 'assistant') {
      const c = o.message?.content
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            out.push(`[${ts}] AI: ${clip(oneLine(b.text), 2000)}`)
          } else if (b?.type === 'tool_use') {
            out.push(`[${ts}]    [tool] ${b.name}: ${clip(briefInput(b.input), 200)}`)
          }
        }
      }
    }
  }
  return out
}

export function renderAgentTranscript(agentId: string): TranscriptResult {
  const file = latestTranscriptFile(agentId)
  if (!file) return { found: false, file: null, text: '[nincs transcript ehhez az ágenshez]', lineCount: 0 }

  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch {
    return { found: false, file, text: '[transcript olvasási hiba]', lineCount: 0 }
  }

  const out = renderTranscriptLines(raw)
  const total = out.length
  const trimmed = total > MAX_RENDERED_LINES ? out.slice(total - MAX_RENDERED_LINES) : out
  return { found: true, file: basename(file), text: trimmed.join('\n') || '[üres transcript]', lineCount: total }
}

// How many recent session files per agent the forensic search scans. Bounds the
// work (and roughly "the last few sessions") without a persistent index.
const SEARCH_FILE_LIMIT = 5

// Case-insensitive substring search over an agent's recent transcripts. Returns
// matching rendered lines (newest files first), capped at maxMatches.
export function searchAgentTranscript(agentId: string, query: string, maxMatches: number): string[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const matches: string[] = []
  for (const file of transcriptFiles(agentId).slice(0, SEARCH_FILE_LIMIT)) {
    let raw: string
    try { raw = readFileSync(file, 'utf-8') } catch { continue }
    for (const line of renderTranscriptLines(raw)) {
      if (line.toLowerCase().includes(needle)) {
        matches.push(line)
        if (matches.length >= maxMatches) return matches
      }
    }
  }
  return matches
}
