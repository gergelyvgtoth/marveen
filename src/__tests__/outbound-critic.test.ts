import { describe, it, expect } from 'vitest'
import { critiqueOutbound } from '../outbound-critic.js'

describe('critiqueOutbound', () => {
  it('passes a clean Hungarian message', () => {
    const r = critiqueOutbound('Kész van a feladat, minden rendben.')
    expect(r.clean).toBe(true)
    expect(r.violations).toEqual([])
  })

  it('blocks em dash', () => {
    const r = critiqueOutbound('Ez kész — és működik.')
    expect(r.clean).toBe(false)
    expect(r.violations.some(v => v.rule === 'em-dash')).toBe(true)
  })

  it('blocks AI clichés', () => {
    const r = critiqueOutbound('Természetesen! Remek kérdés.')
    expect(r.clean).toBe(false)
    expect(r.violations.filter(v => v.rule === 'ai-cliche').length).toBeGreaterThanOrEqual(1)
  })

  it('blocks email signature on telegram', () => {
    const r = critiqueOutbound('Köszi.\nMarveen, Gergely AI asszisztense', 'telegram')
    expect(r.clean).toBe(false)
    expect(r.violations.some(v => v.rule === 'signature-leak')).toBe(true)
  })

  it('allows email signature in email channel', () => {
    const r = critiqueOutbound('Üdv.\nMarveen, Gergely AI asszisztense', 'email')
    expect(r.violations.some(v => v.rule === 'signature-leak')).toBe(false)
  })

  it('blocks leaked bearer token', () => {
    const r = critiqueOutbound('a token: Bearer abcdef1234567890ABCD')
    expect(r.clean).toBe(false)
    expect(r.violations.some(v => v.rule === 'secret-leak')).toBe(true)
  })

  it('blocks internal absolute path leak', () => {
    const r = critiqueOutbound('nézd meg itt: /home/user/marveen/store/.dashboard-token')
    expect(r.clean).toBe(false)
    expect(r.violations.some(v => v.rule === 'secret-leak')).toBe(true)
  })

  it('warns (not blocks) on over-apology', () => {
    const r = critiqueOutbound('Nagyon sajnálom a hibát.')
    expect(r.clean).toBe(true)   // warn does not block
    expect(r.violations.some(v => v.rule === 'over-apology' && v.severity === 'warn')).toBe(true)
  })

  it('handles empty text', () => {
    expect(critiqueOutbound('').clean).toBe(true)
  })
})
