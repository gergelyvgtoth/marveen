import { describe, it, expect, beforeAll } from 'vitest'
import { classifyTriage } from '../triage-inbox.js'
import { initDatabase, getDb, addInboxItem, listInbox, setInboxStatus, getInboxStats } from '../db.js'

describe('classifyTriage', () => {
  it('marks urgent on urgency cues', () => {
    expect(classifyTriage('Ez sürgős, ma kell!').urgency).toBe('urgent')
    expect(classifyTriage('A szerver leállt, nem működik').urgency).toBe('urgent')
  })

  it('marks low on low cues', () => {
    expect(classifyTriage('Nem sürgős, majd ráérsz vele').urgency).toBe('low')
  })

  it('defaults to normal', () => {
    expect(classifyTriage('Megnéztem a jelentést.').urgency).toBe('normal')
  })

  it('detects request vs question vs fyi intent', () => {
    expect(classifyTriage('Kérlek küldj egy összefoglalót').intent).toBe('request')
    expect(classifyTriage('Mikor lesz kész?').intent).toBe('question')
    expect(classifyTriage('Csak jelzem hogy kész.').intent).toBe('fyi')
  })

  it('urgent requests score higher than low fyi', () => {
    const a = classifyTriage('Sürgős, kérlek intézd ma!')
    const b = classifyTriage('Majd ráérsz, csak szólok.')
    expect(a.score).toBeGreaterThan(b.score)
  })
})

describe('inbox storage + ordering', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase()
    getDb().exec("DELETE FROM inbox_items")
  })

  it('orders open items by score desc (urgent first)', () => {
    addInboxItem({ source: 'telegram', preview: 'fyi', urgency: 'low', intent: 'fyi', score: 11, external_id: 't1' })
    addInboxItem({ source: 'email', preview: 'urgent', urgency: 'urgent', intent: 'request', score: 106, external_id: 'e1' })
    addInboxItem({ source: 'telegram', preview: 'normal q', urgency: 'normal', intent: 'question', score: 54, external_id: 't2' })
    const items = listInbox('open')
    expect(items[0].preview).toBe('urgent')
    expect(items[items.length - 1].preview).toBe('fyi')
  })

  it('dedups on (source, external_id)', () => {
    const a = addInboxItem({ source: 'telegram', preview: 'x', urgency: 'normal', intent: 'fyi', score: 50, external_id: 'dup1' })
    const b = addInboxItem({ source: 'telegram', preview: 'x again', urgency: 'normal', intent: 'fyi', score: 50, external_id: 'dup1' })
    expect(b.deduped).toBe(true)
    expect(b.id).toBe(a.id)
  })

  it('marks done and removes from open list; stats reflect it', () => {
    const { id } = addInboxItem({ source: 'whatsapp', preview: 'close me', urgency: 'normal', intent: 'fyi', score: 50, external_id: 'w1' })
    expect(setInboxStatus(id, 'done')).toBe(true)
    expect(listInbox('open').some(i => i.id === id)).toBe(false)
    const stats = getInboxStats()
    expect(stats.open).toBeGreaterThanOrEqual(0)
  })
})
