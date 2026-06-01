import { describe, it, expect } from 'vitest'
import { compareRecordings, type SessionRecording } from '../session-replay.js'

const base = (events: SessionRecording['events']): SessionRecording => ({ name: 'b', scenario: 's', events })

describe('compareRecordings', () => {
  it('reports identical for the same tool sequence + outcomes', () => {
    const r: SessionRecording['events'] = [
      { type: 'inbound', input: 'szia' },
      { type: 'tool', name: 'Bash', outcome: 'success' },
      { type: 'tool', name: 'reply', outcome: 'success' },
    ]
    const d = compareRecordings(base(r), base(r))
    expect(d.identical).toBe(true)
    expect(d.isRegression).toBe(false)
  })

  it('detects an added tool call', () => {
    const a = base([{ type: 'tool', name: 'Bash', outcome: 'success' }])
    const b = base([{ type: 'tool', name: 'Bash', outcome: 'success' }, { type: 'tool', name: 'WebSearch', outcome: 'success' }])
    const d = compareRecordings(a, b)
    expect(d.toolsAdded).toEqual(['WebSearch'])
    expect(d.identical).toBe(false)
  })

  it('flags a removed previously-successful tool as a regression', () => {
    const a = base([{ type: 'tool', name: 'Bash', outcome: 'success' }, { type: 'tool', name: 'reply', outcome: 'success' }])
    const b = base([{ type: 'tool', name: 'reply', outcome: 'success' }])
    const d = compareRecordings(a, b)
    expect(d.toolsRemoved).toEqual(['Bash'])
    expect(d.isRegression).toBe(true)
  })

  it('flags a success->fail outcome flip as a regression', () => {
    const a = base([{ type: 'tool', name: 'Bash', outcome: 'success' }])
    const b = base([{ type: 'tool', name: 'Bash', outcome: 'fail' }])
    const d = compareRecordings(a, b)
    expect(d.outcomeFlips.length).toBe(1)
    expect(d.outcomeFlips[0]).toMatchObject({ tool: 'Bash', baseline: 'success', candidate: 'fail' })
    expect(d.isRegression).toBe(true)
  })

  it('detects order change without add/remove (not a regression by itself)', () => {
    const a = base([{ type: 'tool', name: 'A', outcome: 'success' }, { type: 'tool', name: 'B', outcome: 'success' }])
    const b = base([{ type: 'tool', name: 'B', outcome: 'success' }, { type: 'tool', name: 'A', outcome: 'success' }])
    const d = compareRecordings(a, b)
    expect(d.orderChanged).toBe(true)
    expect(d.isRegression).toBe(false)
  })

  it('a fail->success flip is an improvement, not a regression', () => {
    const a = base([{ type: 'tool', name: 'Bash', outcome: 'fail' }])
    const b = base([{ type: 'tool', name: 'Bash', outcome: 'success' }])
    const d = compareRecordings(a, b)
    expect(d.outcomeFlips.length).toBe(1)
    expect(d.isRegression).toBe(false)
  })

  it('ignores non-tool events in the diff', () => {
    const a = base([{ type: 'inbound', input: 'x' }, { type: 'tool', name: 'Bash', outcome: 'success' }, { type: 'reply' }])
    const b = base([{ type: 'tool', name: 'Bash', outcome: 'success' }])
    const d = compareRecordings(a, b)
    expect(d.identical).toBe(true)
  })
})
