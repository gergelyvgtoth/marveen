import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase, getDb,
  createSkillExperiment, getActiveSkillExperiment, assignSkillVariant,
  recordSkillVariantOutcome, getSkillExperimentResults, promoteSkillExperiment,
} from '../db.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase()
  getDb().exec("DELETE FROM skill_experiments")
  getDb().exec("DELETE FROM skill_usage_log WHERE skill_name LIKE 'exp-%'")
})

describe('A/B skill experiments', () => {
  it('creates an active experiment', () => {
    const { id } = createSkillExperiment('exp-greet', 'rövid', 'bőbeszédű', 'rövidebb jobb?')
    expect(id).toBeGreaterThan(0)
    const exp = getActiveSkillExperiment('exp-greet')
    expect(exp?.status).toBe('active')
    expect(exp?.variant_a).toBe('rövid')
  })

  it('assigns variants deterministically and evenly (parity)', () => {
    // Fresh skill, no usages yet -> first assignment is A
    createSkillExperiment('exp-route', 'A-desc', 'B-desc')
    expect(assignSkillVariant('exp-route')).toBe('A')
    recordSkillVariantOutcome('exp-route', 'A', 'neutral')
    expect(assignSkillVariant('exp-route')).toBe('B')
    recordSkillVariantOutcome('exp-route', 'B', 'neutral')
    expect(assignSkillVariant('exp-route')).toBe('A')
  })

  it('returns null assignment when no active experiment', () => {
    expect(assignSkillVariant('exp-nonexistent')).toBe(null)
  })

  it('computes results and suggests a winner only with enough data', () => {
    const { id } = createSkillExperiment('exp-win', 'A', 'B')
    // A: 5 usages, 4 positive (rate 0.8); B: 5 usages, 1 positive (rate 0.2)
    for (let i = 0; i < 5; i++) recordSkillVariantOutcome('exp-win', 'A', i < 4 ? 'positive' : 'negative')
    for (let i = 0; i < 5; i++) recordSkillVariantOutcome('exp-win', 'B', i < 1 ? 'positive' : 'negative')
    const r = getSkillExperimentResults(id)!
    expect(r.confident).toBe(true)
    expect(r.a.positiveRate).toBeCloseTo(0.8)
    expect(r.b.positiveRate).toBeCloseTo(0.2)
    expect(r.suggestedWinner).toBe('A')
  })

  it('does not suggest a winner below min sample', () => {
    const { id } = createSkillExperiment('exp-thin', 'A', 'B')
    recordSkillVariantOutcome('exp-thin', 'A', 'positive')
    recordSkillVariantOutcome('exp-thin', 'B', 'negative')
    const r = getSkillExperimentResults(id)!
    expect(r.confident).toBe(false)
    expect(r.suggestedWinner).toBe(null)
  })

  it('promotes a winner and closes the experiment', () => {
    const { id } = createSkillExperiment('exp-promote', 'A', 'B')
    expect(promoteSkillExperiment(id, 'B')).toBe(true)
    expect(getActiveSkillExperiment('exp-promote')).toBeUndefined()
  })

  it('creating a new experiment closes the prior active one for that skill', () => {
    createSkillExperiment('exp-replace', 'A1', 'B1')
    createSkillExperiment('exp-replace', 'A2', 'B2')
    const active = getActiveSkillExperiment('exp-replace')
    expect(active?.variant_a).toBe('A2')
    const all = getDb().prepare("SELECT COUNT(*) as c FROM skill_experiments WHERE skill_name='exp-replace'").get() as { c: number }
    expect(all.c).toBe(2)
  })
})
