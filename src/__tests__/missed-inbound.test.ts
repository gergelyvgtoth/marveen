import { describe, it, expect, vi } from 'vitest'

vi.mock('../db.js', () => ({ createAgentMessage: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { findMissedInbound, buildRedeliveryMessage } = await import('../web/missed-inbound.js')

const row = (type: string, ts: string, content: unknown) => JSON.stringify({ type, timestamp: ts, message: { content } })
const ch = (id: string, body: string) => `<channel source="plugin:telegram:telegram" chat_id="1" message_id="${id}" user="1" ts="x">\n${body}\n</channel>`

// 2026-10-29, Cody: a video and a request answered only with "Login expired".
describe('findMissedInbound', () => {
  const since = Date.parse('2026-10-29T15:00:00Z')

  it('returns the channel messages whose answer was an auth failure', () => {
    const lines = [
      row('user', '2026-10-29T16:00:25Z', ch('84', '(video)')),
      row('assistant', '2026-10-29T16:00:26Z', [{ type: 'text', text: 'Login expired · Please run /login' }]),
      row('user', '2026-10-29T16:00:45Z', ch('86', 'Elemezd ezt a videót')),
      row('assistant', '2026-10-29T16:00:46Z', [{ type: 'text', text: 'Login expired · Please run /login' }]),
    ]
    const m = findMissedInbound(lines, since)
    expect(m.map((x) => x.messageId)).toEqual(['84', '86'])
    expect(m[1].block).toContain('Elemezd ezt a videót')
  })

  it('a message that got a real answer is not returned', () => {
    const lines = [
      row('user', '2026-10-29T16:00:25Z', ch('90', 'szia')),
      row('assistant', '2026-10-29T16:00:30Z', [{ type: 'text', text: 'Szia, itt vagyok.' }]),
    ]
    expect(findMissedInbound(lines, since)).toEqual([])
  })

  it('ignores rows before the window and non-channel user turns', () => {
    const lines = [
      row('user', '2026-10-29T14:00:00Z', ch('70', 'régi')),
      row('assistant', '2026-10-29T14:00:01Z', [{ type: 'text', text: 'Login expired · Please run /login' }]),
      row('user', '2026-10-29T16:03:11Z', 'TEAM MEMBER NOTICE -- inter-agent note'),
      row('assistant', '2026-10-29T16:03:11Z', [{ type: 'text', text: 'Login expired · Please run /login' }]),
      'not json',
    ]
    expect(findMissedInbound(lines, since)).toEqual([])
  })

  it('the re-delivery message keeps the channel blocks and says they are external data', () => {
    const msg = buildRedeliveryMessage([{ messageId: '86', block: ch('86', 'Elemezd'), at: 'x' }])
    expect(msg).toContain('[UJRAKEZBESITES]')
    expect(msg).toContain('kulso adat')
    expect(msg).toContain('message_id="86"')
  })
})
