import { addInboxItem } from './db.js'
import { classifyTriage } from './triage-inbox.js'
import { getRecentGmailMessages, gmailConfigured, type EmailMessage } from './google-api.js'

export type { EmailMessage }

// Pluggable email source so the sync core stays transport-agnostic and unit
// testable. The default fetcher is backed by the existing Google OAuth flow
// (Gmail read-only); swapping in IMAP/Graph later only means another fetcher.
export interface EmailFetcher {
  configured(): boolean
  fetchRecent(sinceTs: number): Promise<EmailMessage[]>
}

export const gmailFetcher: EmailFetcher = {
  configured: gmailConfigured,
  fetchRecent: (sinceTs) => getRecentGmailMessages(sinceTs),
}

export interface EmailSyncResult {
  configured: boolean
  added: number
  skipped: number
  scanned: number
}

// Pull recent emails into the unified triage inbox: classify urgency/intent,
// dedup via external_id = `email-<id>` (mirrors the `tg-<id>` Telegram scheme).
// Returns configured:false (and does nothing) when no email transport is set
// up, so the caller can tell "no email yet" apart from "no new email".
export async function syncEmailsToInbox(
  fetcher: EmailFetcher,
  opts: { sinceTs: number; max?: number } = { sinceTs: 0 },
): Promise<EmailSyncResult> {
  if (!fetcher.configured()) {
    return { configured: false, added: 0, skipped: 0, scanned: 0 }
  }
  const emails = await fetcher.fetchRecent(opts.sinceTs)
  let added = 0, skipped = 0
  for (const e of emails) {
    const body = e.text || ''
    const c = classifyTriage(body, e.subject)
    const res = addInboxItem({
      source: 'email',
      external_id: `email-${e.id}`,
      sender: e.from || null,
      subject: e.subject || null,
      preview: (e.subject ? `${e.subject} -- ` : '') + body.slice(0, 240),
      urgency: c.urgency, intent: c.intent, score: c.score,
      received_at: e.receivedAt,
    })
    if (res.deduped) skipped++; else added++
  }
  return { configured: true, added, skipped, scanned: emails.length }
}
