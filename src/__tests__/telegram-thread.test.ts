import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb, saveTelegramMessage, reconstructThreadContext } from '../db.js'

const NOW = 1_780_000_000

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase()
})

beforeEach(() => {
  getDb().exec('DELETE FROM telegram_history')
})

describe('reconstructThreadContext', () => {
  it('returns none for an empty chat', () => {
    const ctx = reconstructThreadContext('EMPTY')
    expect(ctx.via).toBe('none')
    expect(ctx.anchor).toBeNull()
    expect(ctx.thread).toEqual([])
  })

  it('anchors a terse follow-up to the most recent substantive message (recency)', () => {
    saveTelegramMessage('A', '1', 'in', 'Mennyibe kerül a John Deere 6155R és mikorra szállítható?', 'u', NOW - 300)
    saveTelegramMessage('A', '2', 'out', 'Megnézem az árat és a szállítást, egy perc.', undefined, NOW - 200)
    saveTelegramMessage('A', '3', 'in', 'ok', 'u', NOW - 10) // terse follow-up
    const ctx = reconstructThreadContext('A')
    expect(ctx.via).toBe('recency')
    // anchor must be a real topic, not the "ok" ack
    expect(ctx.anchor?.message_id).toBe('2')
    expect(ctx.thread.map(r => r.message_id)).toEqual(['1', '2', '3']) // chronological
  })

  it('follows an explicit reply_to link when present', () => {
    saveTelegramMessage('B', '10', 'in', 'A régi téma, traktor alkatrész.', 'u', NOW - 1000)
    saveTelegramMessage('B', '11', 'out', 'Itt a régi téma válasza.', undefined, NOW - 900)
    saveTelegramMessage('B', '20', 'in', 'Egy teljesen friss kérdés a finanszírozásról.', 'u', NOW - 100)
    // terse follow-up that explicitly replies to the OLD message 11
    saveTelegramMessage('B', '21', 'in', 'részletezd', 'u', NOW - 10, '11')
    const ctx = reconstructThreadContext('B')
    expect(ctx.via).toBe('reply_to')
    expect(ctx.anchor?.message_id).toBe('11')
  })

  it('honors an explicitly passed replyToMessageId over recency', () => {
    saveTelegramMessage('C', '1', 'in', 'Első érdemi téma a vetőgépről.', 'u', NOW - 500)
    saveTelegramMessage('C', '2', 'in', 'Második érdemi téma a permetezőről.', 'u', NOW - 100)
    const ctx = reconstructThreadContext('C', { replyToMessageId: '1' })
    expect(ctx.via).toBe('reply_to')
    expect(ctx.anchor?.message_id).toBe('1')
  })

  it('falls back to the last message when nothing is substantive', () => {
    saveTelegramMessage('D', '1', 'in', 'ja', 'u', NOW - 100)
    saveTelegramMessage('D', '2', 'in', 'ok', 'u', NOW - 10)
    const ctx = reconstructThreadContext('D', { minMeaningfulLen: 25 })
    expect(ctx.via).toBe('recency')
    expect(ctx.anchor?.message_id).toBe('2')
  })

  it('respects the limit (thread window size)', () => {
    for (let i = 1; i <= 15; i++) {
      saveTelegramMessage('E', String(i), 'in', `üzenet ${i} ami elég hosszú ahhoz hogy érdemi legyen`, 'u', NOW - (20 - i) * 10)
    }
    const ctx = reconstructThreadContext('E', { limit: 5 })
    expect(ctx.thread.length).toBe(5)
    // last 5 chronologically: 11..15
    expect(ctx.thread.map(r => r.message_id)).toEqual(['11', '12', '13', '14', '15'])
  })
})
