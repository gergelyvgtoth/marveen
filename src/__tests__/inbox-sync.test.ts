import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, getUnansweredInboundTelegram } from '../db.js'

const NOW = 1_780_000_000

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase()
  getDb().exec('DELETE FROM telegram_history')
  const ins = getDb().prepare('INSERT INTO telegram_history (chat_id, message_id, user_id, direction, text, ts) VALUES (?,?,?,?,?,?)')
  // chat A: inbound then outbound reply -> ANSWERED (excluded)
  ins.run('A', '1', 'u', 'in', 'kérdés A', NOW - 1000)
  ins.run('A', '2', null, 'out', 'válasz A', NOW - 900)
  // chat B: inbound with no later outbound -> UNANSWERED (included)
  ins.run('B', '3', 'u', 'in', 'sürgős B kérdés', NOW - 500)
  // chat C: outbound then inbound (inbound is last) -> UNANSWERED
  ins.run('C', '4', null, 'out', 'régi válasz C', NOW - 800)
  ins.run('C', '5', 'u', 'in', 'új kérdés C', NOW - 400)
  // old inbound outside window -> excluded by since
  ins.run('D', '6', 'u', 'in', 'nagyon régi', NOW - 99 * 86400)
})

describe('getUnansweredInboundTelegram', () => {
  it('returns only unanswered inbound within the window', () => {
    const since = NOW - 3 * 86400
    const rows = getUnansweredInboundTelegram(since)
    const ids = rows.map(r => r.message_id).sort()
    expect(ids).toEqual(['3', '5'])   // B and C unanswered; A answered; D too old
  })

  it('excludes answered chats (outbound after inbound)', () => {
    const rows = getUnansweredInboundTelegram(NOW - 3 * 86400)
    expect(rows.some(r => r.chat_id === 'A')).toBe(false)
  })

  it('respects the since window', () => {
    const rows = getUnansweredInboundTelegram(NOW - 200 * 86400)
    expect(rows.some(r => r.message_id === '6')).toBe(true)
  })
})
