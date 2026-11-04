import wire from '@shared/types/__fixtures__/automation.json'
import { describe, expect, it } from 'vitest'
import { parseRun, parseRunList, parseStepList } from '@/lib/automation-wire'

describe('automation wire parser', () => {
  it('round-trips the fixture runs and steps, loops, merges and waits included', () => {
    expect(parseRunList(wire.runs)).toEqual(wire.runs)
    expect(parseStepList(wire.steps)).toEqual(wire.steps)
  })

  it('reads the control-flow kinds, the item port and a parked step', () => {
    const { graph } = parseRun(wire.runs[0])
    expect(graph.nodes.map((node) => node.spec)).toEqual([
      { kind: 'for_each', items: '{{trigger.kind}}', max_iterations: 5 },
      expect.objectContaining({ kind: 'transform' }),
      { kind: 'merge', mode: 'any' },
      { kind: 'wait', duration_ms: 3600000 },
      { kind: 'fail', message: '{{trigger.kind}}' }
    ])
    expect(graph.edges[1]).toEqual({ from: 'each', port: 'item', to: 'body' })
    expect(parseStepList(wire.steps).at(-1)).toMatchObject({
      node_id: 'pause',
      iteration: null,
      status: 'waiting',
      wait_until: 1773050461000
    })
  })

  it('reads a step without the new fields as outside any loop and not parked', () => {
    const { iteration: _, wait_until: __, ...legacy } = wire.steps[0]
    expect(parseStepList([legacy])[0]).toMatchObject({ iteration: null, wait_until: null })
  })

  it('rejects an unknown merge mode and port', () => {
    const run = structuredClone(wire.runs[0])
    run.graph.nodes[2].spec = { kind: 'merge', mode: 'some' } as never
    expect(() => parseRun(run)).toThrow(/mode/)
    const edge = structuredClone(wire.runs[0])
    edge.graph.edges[1].port = 'each'
    expect(() => parseRun(edge)).toThrow(/port/)
  })
})
