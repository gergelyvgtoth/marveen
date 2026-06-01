import { describe, it, expect } from 'vitest'
import { computeOpportunities, type ScoredMemory } from '../sales-opportunities.js'

const NOW = 1_780_000_000
const mem = (id: number, content: string, ageDays = 1): ScoredMemory =>
  ({ id, content, created_at: NOW - ageDays * 86400 })

describe('computeOpportunities', () => {
  it('scores a company with open offer + machine interest + fresh negotiation high', () => {
    const r = computeOpportunities([
      mem(1, 'Az XY Kft érdeklődött egy John Deere 6120M iránt, ajánlat kiment.'),
      mem(2, 'Tárgyalás az XY Kft-vel ma.', 0),
    ], NOW)
    expect(r[0].company).toBe('XY Kft')
    // open_offer(40) + machine_interest(20) + fresh negotiation(30) -> >= 90
    expect(r[0].score).toBeGreaterThanOrEqual(90)
    expect(r[0].signals.map(s => s.kind)).toContain('open_offer')
    expect(r[0].signals.map(s => s.kind)).toContain('recent_negotiation')
  })

  it('does not count a closed offer as open', () => {
    const r = computeOpportunities([
      mem(1, 'Az ABC Kft ajánlatát megrendelték, szerződés aláírva.'),
    ], NOW)
    const abc = r.find(o => o.company === 'ABC Kft')
    // offer present but closed -> no open_offer signal
    expect(abc?.signals.some(s => s.kind === 'open_offer')).toBeFalsy()
  })

  it('ranks higher-score company first', () => {
    const r = computeOpportunities([
      mem(1, 'Az XY Kft érdeklődött, ajánlat kiment, tárgyalás ma.', 0),
      mem(2, 'A ZZ Kft kapcsolattartója jelentkezett.'),
    ], NOW)
    expect(r[0].company).toBe('XY Kft')
    expect(r[0].score).toBeGreaterThan(r[1].score)
  })

  it('deduplicates the same signal kind across multiple mentions', () => {
    const r = computeOpportunities([
      mem(1, 'XY Kft ajánlat.'),
      mem(2, 'XY Kft ajánlat megint.'),
      mem(3, 'XY Kft ajánlat harmadszor.'),
    ], NOW)
    const xy = r.find(o => o.company === 'XY Kft')!
    // open_offer counted once, not 3x
    expect(xy.signals.filter(s => s.kind === 'open_offer').length).toBe(1)
    expect(xy.score).toBe(40)
  })

  it('weights stale negotiation lower than fresh', () => {
    const fresh = computeOpportunities([mem(1, 'Tárgyalás az XY Kft-vel.', 0)], NOW)[0]
    const stale = computeOpportunities([mem(1, 'Tárgyalás a ZZ Kft-vel.', 90)], NOW)[0]
    expect(fresh.score).toBeGreaterThan(stale.score)
  })

  it('ignores companies with no opportunity signal', () => {
    const r = computeOpportunities([mem(1, 'Az XY Kft létezik.')], NOW)
    expect(r.length).toBe(0)
  })
})
