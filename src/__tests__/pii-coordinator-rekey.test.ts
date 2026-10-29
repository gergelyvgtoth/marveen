import { describe, it, expect, vi } from 'vitest'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { rekeyChatMapping, chatMappingFile } = await import('../channel-coordinator.js')

// Szotasz review on #1934, item 1: the service numbers from _1 on every call, and
// the coordinator's plain spread let a second person overwrite SZEMELY_1.
describe('rekeyChatMapping', () => {
  it('a second message with a different person gets a new K marker, the first stays', () => {
    const first = rekeyChatMapping({}, { SZEMELY_1: 'Első Ember' }, 'Szia SZEMELY_1')
    expect(first).toEqual({ text: 'Szia SZEMELY_K1', mapping: { SZEMELY_K1: 'Első Ember' } })
    const second = rekeyChatMapping(first.mapping, { SZEMELY_1: 'Második Ember' }, 'Hívd SZEMELY_1-t')
    expect(second.text).toBe('Hívd SZEMELY_K2-t')
    expect(second.mapping).toEqual({ SZEMELY_K1: 'Első Ember', SZEMELY_K2: 'Második Ember' })
  })

  it('a known value keeps its marker across messages', () => {
    const r = rekeyChatMapping({ SZEMELY_K1: 'Első Ember' }, { SZEMELY_1: 'Más', SZEMELY_2: 'Első Ember' }, 'SZEMELY_1 és SZEMELY_2')
    expect(r.text).toBe('SZEMELY_K2 és SZEMELY_K1')
    expect(r.mapping).toEqual({ SZEMELY_K1: 'Első Ember', SZEMELY_K2: 'Más' })
  })

  it('SZEMELY_1 never eats the prefix of SZEMELY_10', () => {
    const fresh: Record<string, string> = {}
    for (let i = 1; i <= 10; i++) fresh[`SZEMELY_${i}`] = `N${i}`
    const r = rekeyChatMapping({}, fresh, 'SZEMELY_10 SZEMELY_1')
    expect(r.text).toBe('SZEMELY_K10 SZEMELY_K1')
  })

  it('the chat mapping path is per chat and safe', () => {
    expect(chatMappingFile(123456789)).toMatch(/\.pii-mapper\/chat-123456789\/mapping\.json$/)
    expect(chatMappingFile('../../etc')).not.toContain('..')
  })
})
