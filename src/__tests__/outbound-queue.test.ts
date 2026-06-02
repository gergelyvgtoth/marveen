import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import {
  initDatabase, getDb,
  enqueueOutbound, countPendingOutbound, claimPendingOutbound,
  markOutboundSent, markOutboundFailed, listOutbound, getOutboundQueueStats,
} from '../db.js'
import { buildResendPrompt } from '../web/outbound-resend.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase()
})

beforeEach(() => {
  getDb().exec('DELETE FROM outbound_queue')
})

describe('outbound queue', () => {
  it('enqueues a failed outbound as pending', () => {
    const id = enqueueOutbound({ agentId: 'marveen', chatId: '42', text: 'szia', error: 'pipe closed' })
    expect(id).toBeGreaterThan(0)
    expect(countPendingOutbound('marveen')).toBe(1)
    const [row] = listOutbound('pending')
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.last_error).toBe('pipe closed')
    expect(row.dispatched_at).toBeNull()
  })

  it('claim stamps dispatched_at and is not re-claimable', () => {
    enqueueOutbound({ agentId: 'marveen', chatId: '42', text: 'egy' })
    enqueueOutbound({ agentId: 'marveen', chatId: '42', text: 'kettő' })
    const first = claimPendingOutbound('marveen')
    expect(first.length).toBe(2)
    // second claim returns nothing: both are dispatched now (no re-injection loop)
    const second = claimPendingOutbound('marveen')
    expect(second.length).toBe(0)
    // they are still pending (agent hasn't confirmed send yet)
    expect(countPendingOutbound('marveen')).toBe(2)
  })

  it('isolates claims per agent', () => {
    enqueueOutbound({ agentId: 'marveen', chatId: '1', text: 'a' })
    enqueueOutbound({ agentId: 'agrolanc', chatId: '2', text: 'b' })
    const claimed = claimPendingOutbound('marveen')
    expect(claimed.length).toBe(1)
    expect(claimed[0].agent_id).toBe('marveen')
    expect(countPendingOutbound('agrolanc')).toBe(1)
  })

  it('marks rows sent / failed and updates stats', () => {
    const a = enqueueOutbound({ agentId: 'marveen', chatId: '1', text: 'a' })
    const b = enqueueOutbound({ agentId: 'marveen', chatId: '1', text: 'b' })
    expect(markOutboundSent(a)).toBe(true)
    expect(markOutboundFailed(b, 'gave up')).toBe(true)
    expect(countPendingOutbound('marveen')).toBe(0)
    const stats = getOutboundQueueStats()
    expect(stats).toEqual({ pending: 0, sent: 1, failed: 1 })
  })

  it('mark on a missing id returns false', () => {
    expect(markOutboundSent(99999)).toBe(false)
  })
})

describe('buildResendPrompt', () => {
  it('returns empty string for no rows', () => {
    expect(buildResendPrompt([])).toBe('')
  })

  it('lists each queued message with its id and chat_id', () => {
    enqueueOutbound({ agentId: 'marveen', chatId: '42', text: 'első üzenet' })
    enqueueOutbound({ agentId: 'marveen', chatId: '7', text: 'második', replyToMessageId: '100' })
    const rows = claimPendingOutbound('marveen')
    const prompt = buildResendPrompt(rows)
    expect(prompt).toContain('[Resend]')
    expect(prompt).toContain('2 kimenő üzenet')
    expect(prompt).toContain('chat_id=42')
    expect(prompt).toContain('első üzenet')
    expect(prompt).toContain('reply_to: 100')
    expect(prompt).toContain('/api/outbound-queue/')
  })
})
