import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, recordCriticSample, getCriticSuggestions } from '../db.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase()
  getDb().exec('DELETE FROM critic_samples')
})

describe('self-improving critic samples', () => {
  it('records one row per violation and aggregates by rule', () => {
    recordCriticSample('telegram', true, [{ rule: 'em-dash', match: '—' }], 'ez kész — most')
    recordCriticSample('telegram', true, [{ rule: 'em-dash', match: '—' }], 'másik — eset')
    recordCriticSample('telegram', true, [{ rule: 'ai-cliche', match: 'Természetesen' }], 'Természetesen!')
    const s = getCriticSuggestions()
    expect(s.blocked).toBe(3)
    expect(s.byRule['em-dash']).toBe(2)
    expect(s.byRule['ai-cliche']).toBe(1)
  })

  it('surfaces the most frequent match strings', () => {
    const s = getCriticSuggestions()
    expect(s.topMatches[0].match).toBe('—')
    expect(s.topMatches[0].count).toBe(2)
  })

  it('records a clean sample with no violations', () => {
    recordCriticSample('telegram', false, [], 'tiszta üzenet')
    const s = getCriticSuggestions()
    expect(s.total).toBeGreaterThan(s.blocked)   // clean sample counted in total, not blocked
  })
})
