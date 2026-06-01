import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  getDb,
  recordOutboundAudit,
  getOutboundAudit,
  getOutboundAuditStats,
} from '../db.js'
import { filterOutbound } from '../data-gate.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase()
  // Start from a clean audit table so counts are deterministic.
  getDb().exec('DELETE FROM outbound_audit')
})

describe('outbound audit log', () => {
  it('records batched entries and reads them back newest-first', () => {
    recordOutboundAudit([
      { memory_id: 1, purpose: 'test', sensitivity: 'technical', scope: 'claude_code_ok', allowed: true, reason: 'ok:technical' },
      { memory_id: 'mem-2', purpose: 'test', sensitivity: 'pii', scope: 'local_only', allowed: false, reason: 'scope:local_only' },
    ])
    const rows = getOutboundAudit({ purpose: 'test' })
    expect(rows.length).toBe(2)
    // memory_id is normalized to TEXT
    expect(typeof rows[0].memory_id).toBe('string')
  })

  it('filters by allowed flag', () => {
    const blocked = getOutboundAudit({ purpose: 'test', allowed: false })
    expect(blocked.every(r => r.allowed === 0)).toBe(true)
    expect(blocked.length).toBeGreaterThan(0)
  })

  it('computes stats', () => {
    const stats = getOutboundAuditStats()
    expect(stats.total).toBeGreaterThanOrEqual(2)
    expect(stats.allowed + stats.blocked).toBe(stats.total)
    expect(Object.keys(stats.byReason).length).toBeGreaterThan(0)
  })

  it('filterOutbound writes an audit row per evaluated item', () => {
    getDb().exec("DELETE FROM outbound_audit WHERE purpose = 'gate-integration'")
    const items = [
      { id: 100, content: 'local secret', scope: 'local_only' as const, sensitivity: 'technical' as const },
      { id: 101, content: 'public fact', scope: 'claude_code_ok' as const, sensitivity: 'public' as const },
    ]
    const passed = filterOutbound(items, 'gate-integration')
    // Only the claude_code_ok/public item passes the gate
    expect(passed.map(p => p.id)).toEqual([101])
    // But BOTH items are audited (allowed + blocked)
    const audited = getOutboundAudit({ purpose: 'gate-integration' })
    expect(audited.length).toBe(2)
    const blockedRow = audited.find(r => r.memory_id === '100')
    expect(blockedRow?.allowed).toBe(0)
    expect(blockedRow?.reason).toBe('scope:local_only')
  })
})
