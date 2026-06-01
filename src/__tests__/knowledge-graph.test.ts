import { describe, it, expect } from 'vitest'
import { extractEntities, buildKnowledgeGraph } from '../knowledge-graph.js'

describe('extractEntities', () => {
  it('extracts companies by legal-form suffix', () => {
    const e = extractEntities('Az XY Kft érdeklődött egy traktor iránt.')
    expect(e.some(x => x.name === 'XY Kft' && x.type === 'company')).toBe(true)
  })

  it('extracts multi-word machine brand + model as one entity', () => {
    const e = extractEntities('Bemutattuk a John Deere 6120M traktort.')
    const machine = e.find(x => x.type === 'machine')
    expect(machine?.name).toBe('John Deere 6120M')
  })

  it('resolves curated known entities with correct type', () => {
    const e = extractEntities('Gergely az Agrolánc sales vezetője.')
    expect(e.find(x => x.name === 'Gergely')?.type).toBe('person')
    expect(e.find(x => x.name === 'Agrolánc')?.type).toBe('company')
  })

  it('does not duplicate the same entity within one text', () => {
    const e = extractEntities('Agrolánc, Agrolánc, és megint Agrolánc.')
    expect(e.filter(x => x.name === 'Agrolánc').length).toBe(1)
  })

  it('returns empty for entity-free text', () => {
    expect(extractEntities('semmi érdekes itt nincs')).toEqual([])
  })
})

describe('buildKnowledgeGraph', () => {
  const memories = [
    { id: 1, content: 'Kovács János az XY Kft ügyvezetője.' },
    { id: 2, content: 'Az XY Kft érdeklődött egy John Deere 6120M iránt.' },
    { id: 3, content: 'Tárgyalás az XY Kft-vel, ajánlat kiment.' },
  ]

  it('creates nodes for distinct entities and co-occurrence edges', () => {
    const g = buildKnowledgeGraph(memories)
    const labels = g.nodes.map(n => n.label)
    expect(labels).toContain('XY Kft')
    expect(labels).toContain('John Deere 6120M')
    // memory 2 co-mentions XY Kft + the machine -> an edge between them
    expect(g.edges.length).toBeGreaterThan(0)
    g.edges.forEach(e => {
      expect(e.source).toBeGreaterThanOrEqual(0)
      expect(e.target).toBeGreaterThanOrEqual(0)
      expect(e.source).toBeLessThan(g.nodes.length)
    })
  })

  it('labels edges with a relation cue when present', () => {
    const g = buildKnowledgeGraph([
      { id: 1, content: 'Az XY Kft érdeklődött a John Deere 6120M iránt.' },
    ])
    expect(g.edges[0]?.label).toBe('érdeklődött')
  })

  it('accumulates mention counts', () => {
    const g = buildKnowledgeGraph(memories)
    const xy = g.nodes.find(n => n.label === 'XY Kft')
    expect(xy?.mentions).toBe(3)
  })

  it('focus returns only the entity and its direct neighbours', () => {
    const g = buildKnowledgeGraph(memories, 'John Deere 6120M')
    const labels = g.nodes.map(n => n.label)
    expect(labels).toContain('John Deere 6120M')
    expect(labels).toContain('XY Kft')        // direct neighbour via memory 2
    // Kovács János only co-occurs with XY Kft (mem 1), not the machine -> excluded
    expect(labels).not.toContain('Kovács János')
  })
})
