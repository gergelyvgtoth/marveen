import type { OutboundQueueRow } from '../db.js'

// Build the prompt injected into an agent's session after a successful channel
// reconnect, asking it to resend the outbound messages that were lost while the
// MCP pipe was down. The agent owns the reply tool, so the backend cannot send
// directly -- it hands the queued messages back and asks the agent to resend,
// then mark each row sent via PUT /api/outbound-queue/:id.
export function buildResendPrompt(rows: OutboundQueueRow[]): string {
  if (rows.length === 0) return ''
  const lines = rows.map((r) => {
    const replyHint = r.reply_to_message_id ? ` (reply_to: ${r.reply_to_message_id})` : ''
    const text = r.text.replace(/\s+/g, ' ').trim()
    return `- [queue #${r.id}] chat_id=${r.chat_id}${replyHint}: ${text}`
  })
  return [
    `[Resend] ${rows.length} kimenő üzenet nem ment ki MCP-kiesés alatt, a csatorna most újra él. ` +
      `Küldd újra ezeket a reply tool-lal, majd minden sikeres küldés után jelöld elküldöttnek: ` +
      `PUT http://localhost:3420/api/outbound-queue/<id> { "status": "sent" }. ` +
      `Ha egy üzenet már nem releváns, jelöld failed-nek és menj tovább.`,
    ...lines,
  ].join('\n')
}
