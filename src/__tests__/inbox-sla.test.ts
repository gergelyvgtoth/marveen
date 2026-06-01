import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, addInboxItem, getInboxSlaBreaches } from '../db.js'

const NOW = 1_780_000_000

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase()
  getDb().exec("DELETE FROM inbox_items")
})

describe('inbox SLA breaches', () => {
  it('flags an urgent item older than the threshold', () => {
    addInboxItem({ source: 'telegram', preview: 'old urgent', urgency: 'urgent', intent: 'request', score: 106, external_id: 'sla-old', received_at: NOW - 3600 })
    addInboxItem({ source: 'telegram', preview: 'fresh urgent', urgency: 'urgent', intent: 'request', score: 106, external_id: 'sla-fresh', received_at: NOW - 60 })
    const breaches = getInboxSlaBreaches(NOW, 1800, false)
    const previews = breaches.map(b => b.preview)
    expect(previews).toContain('old urgent')
    expect(previews).not.toContain('fresh urgent')
  })

  it('ignores non-urgent stuck items', () => {
    addInboxItem({ source: 'email', preview: 'old normal', urgency: 'normal', intent: 'fyi', score: 50, external_id: 'sla-normal', received_at: NOW - 99999 })
    const breaches = getInboxSlaBreaches(NOW, 1800, false)
    expect(breaches.some(b => b.preview === 'old normal')).toBe(false)
  })

  it('claim stamps escalated_at so the same item is not returned twice', () => {
    const first = getInboxSlaBreaches(NOW, 1800, true)
    expect(first.some(b => b.preview === 'old urgent')).toBe(true)
    const second = getInboxSlaBreaches(NOW, 1800, true)
    expect(second.some(b => b.preview === 'old urgent')).toBe(false)
  })
})
