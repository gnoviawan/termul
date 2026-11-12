import wire from '@shared/types/__fixtures__/automation.json'
import { describe, expect, it } from 'vitest'
import {
  parseApprovalOutput,
  parseAutomation,
  parseRun,
  parseRunList,
  parseStepList
} from '@/lib/automation-wire'

describe('automation wire parser', () => {
  it('round-trips the fixture runs and steps, loops, merges, waits and approvals included', () => {
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
      { kind: 'approval', message: 'Ship {{nodes.body.output.item}}?', timeout_ms: 86400000 },
      { kind: 'fail', message: '{{trigger.kind}}' }
    ])
    expect(graph.edges[1]).toEqual({ from: 'each', port: 'item', to: 'body' })
    expect(parseStepList(wire.steps)[4]).toMatchObject({
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

  it('reads where a running run is parked, a wait or an approval in a loop', () => {
    expect(parseRunList(wire.runs).map((run) => [run.status, run.parked])).toEqual([
      ['failed', null],
      ['running', { node_id: 'pause', iteration: null, until: 1773050461000 }],
      ['running', { node_id: 'gate', iteration: 1, until: 1773133261000 }]
    ])
  })

  it('reads a run from a host without parked runs as not parked', () => {
    const { parked: _, ...legacy } = wire.runs[1]
    expect(parseRun(legacy).parked).toBeNull()
  })

  it('rejects an approval without a numeric timeout and a parked run without a deadline', () => {
    const run = structuredClone(wire.runs[0])
    run.graph.nodes[4].spec = { kind: 'approval', message: 'ok?', timeout_ms: '1h' } as never
    expect(() => parseRun(run)).toThrow('run.graph.nodes[4].spec.timeout_ms: expected a number')
    const parked = structuredClone(wire.runs[1])
    parked.parked = { node_id: 'pause' } as never
    expect(() => parseRun(parked)).toThrow('run.parked.until: expected a number')
  })

  it('reads an approval output before and after the decision', () => {
    const [waiting, decided] = parseStepList(wire.steps).slice(5)
    expect(parseApprovalOutput(waiting.output)).toEqual({ message: 'Ship b?' })
    expect(parseApprovalOutput(decided.output)).toEqual({
      message: 'Ship a?',
      decision: 'rejected',
      decided_at: 1773046900000
    })
  })

  it('reads any other output as no approval detail', () => {
    expect(parseApprovalOutput(null)).toBeNull()
    expect(parseApprovalOutput({ resumed_at: 9 })).toBeNull()
    expect(parseApprovalOutput({ message: 'x', decision: 'maybe', decided_at: 9 })).toBeNull()
    expect(parseApprovalOutput({ message: 'x', decision: 'approved' })).toBeNull()
  })

  it('reads the node positions of an automation', () => {
    expect(parseAutomation(wire.automation).layout).toEqual({
      trigger: { x: 0, y: 40 },
      fetch: { x: 240, y: 40.5 },
      extract: { x: 480, y: -16 }
    })
  })

  it('rejects a reply without a layout and a position that is not a number', () => {
    const { layout: _, ...bare } = wire.automation
    expect(() => parseAutomation(bare)).toThrow(/layout/)
    const bad = structuredClone(wire.automation)
    ;(bad.layout as Record<string, unknown>).fetch = { x: '240', y: 0 }
    expect(() => parseAutomation(bad)).toThrow(/layout\.fetch\.x/)
  })
})
