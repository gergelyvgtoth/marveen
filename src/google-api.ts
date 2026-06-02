import https from 'node:https'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from './logger.js'

const TOKENS_PATH = join(homedir(), '.config', 'google-calendar-mcp', 'tokens.json')
const CLIENT_CREDS_PATH = join(homedir(), '.gmail-mcp', 'gcp-oauth.keys.json')

interface TokenData {
  access_token: string
  refresh_token: string
  expiry_date: number
  token_type: string
  scope: string
}

interface ClientCredentials {
  installed: {
    client_id: string
    client_secret: string
    token_uri: string
  }
}

interface CalendarEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  status?: string
  location?: string
  description?: string
  attendees?: Array<{ email: string; responseStatus?: string; displayName?: string }>
}

interface CalendarListResponse {
  items?: CalendarEvent[]
}

let cachedTokens: { normal: TokenData } | null = null
let cachedClient: ClientCredentials | null = null

function loadTokens(): TokenData {
  if (!cachedTokens) {
    cachedTokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf-8'))
  }
  return cachedTokens!.normal
}

function saveTokens(tokens: TokenData): void {
  cachedTokens = { normal: tokens }
  writeFileSync(TOKENS_PATH, JSON.stringify(cachedTokens, null, 2))
}

function loadClientCredentials(): ClientCredentials {
  if (!cachedClient) {
    cachedClient = JSON.parse(readFileSync(CLIENT_CREDS_PATH, 'utf-8'))
  }
  return cachedClient!
}

function httpsRequest(url: string, options: https.RequestOptions, body?: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          data: Buffer.concat(chunks).toString('utf-8'),
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function refreshAccessToken(): Promise<string> {
  const tokens = loadTokens()
  const client = loadClientCredentials()

  const params = new URLSearchParams({
    client_id: client.installed.client_id,
    client_secret: client.installed.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  })

  const { status, data } = await httpsRequest(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
    params.toString()
  )

  if (status !== 200) {
    logger.error({ status, body: data }, 'Google token refresh failed')
    throw new Error(`Token refresh failed: ${status}`)
  }

  const refreshed = JSON.parse(data)
  const updated: TokenData = {
    ...tokens,
    access_token: refreshed.access_token,
    expiry_date: Date.now() + (refreshed.expires_in * 1000),
  }
  saveTokens(updated)
  logger.info('Google access token refreshed')
  return updated.access_token
}

async function getValidAccessToken(): Promise<string> {
  const tokens = loadTokens()
  // Refresh if token expires within 5 minutes
  if (Date.now() > tokens.expiry_date - 5 * 60 * 1000) {
    return refreshAccessToken()
  }
  return tokens.access_token
}

export async function getCalendarEvents(
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  const token = await getValidAccessToken()

  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '20',
  })

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`

  const { status, data } = await httpsRequest(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (status === 401) {
    // Token expired mid-flight, refresh and retry once
    const newToken = await refreshAccessToken()
    const retry = await httpsRequest(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${newToken}` },
    })
    if (retry.status !== 200) {
      logger.error({ status: retry.status, body: retry.data }, 'Google Calendar API error after refresh')
      return []
    }
    const parsed: CalendarListResponse = JSON.parse(retry.data)
    return parsed.items ?? []
  }

  if (status !== 200) {
    logger.error({ status, body: data }, 'Google Calendar API error')
    return []
  }

  const parsed: CalendarListResponse = JSON.parse(data)
  return parsed.items ?? []
}

// --- Gmail (read-only) ---
// Reuses the same OAuth token flow as Calendar. Inert unless a token exists at
// TOKENS_PATH whose scope grants Gmail read access; getRecentGmailMessages
// throws a clear error when the token is missing so callers can report
// "email not configured" instead of crashing.

export interface EmailMessage {
  id: string
  from: string
  subject: string
  text: string
  receivedAt: number // unix seconds
}

export function gmailConfigured(): boolean {
  try {
    const t = loadTokens()
    return Boolean(t.refresh_token)
  } catch {
    return false
  }
}

interface GmailListResponse { messages?: Array<{ id: string }> }
interface GmailHeader { name: string; value: string }
interface GmailMessageResponse {
  id: string
  internalDate?: string
  snippet?: string
  payload?: { headers?: GmailHeader[] }
}

async function gmailGet(pathAndQuery: string, token: string): Promise<{ status: number; data: string }> {
  return httpsRequest(`https://gmail.googleapis.com/gmail/v1/users/me/${pathAndQuery}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

// Fetch recent inbox messages received since `sinceTs` (unix seconds). Returns
// lightweight metadata (from/subject/snippet) suitable for triage classification.
export async function getRecentGmailMessages(sinceTs: number, max: number = 25): Promise<EmailMessage[]> {
  if (!gmailConfigured()) throw new Error('Gmail not configured (no Google token with Gmail scope)')
  let token = await getValidAccessToken()
  // Gmail's `after:` query takes seconds since epoch.
  const q = encodeURIComponent(`in:inbox after:${sinceTs}`)
  let list = await gmailGet(`messages?q=${q}&maxResults=${max}`, token)
  if (list.status === 401) {
    token = await refreshAccessToken()
    list = await gmailGet(`messages?q=${q}&maxResults=${max}`, token)
  }
  if (list.status !== 200) {
    logger.error({ status: list.status, body: list.data }, 'Gmail list error')
    return []
  }
  const ids = (JSON.parse(list.data) as GmailListResponse).messages ?? []
  const out: EmailMessage[] = []
  for (const { id } of ids) {
    const r = await gmailGet(`messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, token)
    if (r.status !== 200) continue
    const m = JSON.parse(r.data) as GmailMessageResponse
    const headers = m.payload?.headers ?? []
    const from = headers.find(h => h.name.toLowerCase() === 'from')?.value ?? ''
    const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value ?? ''
    out.push({
      id: m.id,
      from,
      subject,
      text: m.snippet ?? '',
      receivedAt: m.internalDate ? Math.floor(Number(m.internalDate) / 1000) : sinceTs,
    })
  }
  return out
}

export type { CalendarEvent }
