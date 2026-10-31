import type { Graph, NodeId, NodeSpec } from '@shared/types/automation.types'
import { describe, expect, it } from 'vitest'
import { layoutGraph } from './automation-layout'

const METRICS = { nodeWidth: 240, nodeHeight: 60, gapX: 20, gapY: 40 }
const transform: NodeSpec = { kind: 'transform', fields: [] }

function graph(nodeIds: string[], edges: [string, string, string][]): Graph {
  return {
    nodes: nodeIds.map((id) => ({ id: id as NodeId, label: id, spec: transform })),
    edges: edges.map(([from, port, to]) => ({
      from: from as NodeId,
      port: port as 'out',
      to: to as NodeId
    }))
  }
}

describe('layoutGraph', () => {
  it('ranks a branching graph by longest path and orders rows by their parents', () => {
    const layout = layoutGraph(
      graph(
        ['fetch', 'check', 'alert', 'page', 'post', 'skip'],
        [
          ['trigger', 'out', 'fetch'],
          ['fetch', 'out', 'check'],
          ['fetch', 'error', 'alert'],
          ['alert', 'out', 'page'],
          ['check', 'true', 'post'],
          ['check', 'false', 'skip']
        ]
      ),
      METRICS
    )

    expect(layout.width).toBe(760)
    expect(layout.height).toBe(360)
    expect(layout.nodes.map(({ id, rank, order, x, y }) => [id, rank, order, x, y])).toEqual([
      ['trigger', 0, 0, 260, 0],
      ['fetch', 1, 0, 260, 100],
      ['check', 2, 0, 130, 200],
      ['alert', 2, 1, 390, 200],
      // `page` is first in the input but its parent sits right of `check`.
      ['page', 3, 2, 520, 300],
      ['post', 3, 0, 0, 300],
      ['skip', 3, 1, 260, 300]
    ])
    expect(layout.edges.slice(1, 3)).toEqual([
      { from: 'fetch', to: 'check', port: 'out', x1: 340, y1: 160, x2: 250, y2: 200 },
      { from: 'fetch', to: 'alert', port: 'error', x1: 420, y1: 160, x2: 510, y2: 200 }
    ])
  })

  it('puts a join below its deepest parent', () => {
    const layout = layoutGraph(
      graph(
        ['a', 'b', 'join'],
        [
          ['trigger', 'out', 'a'],
          ['a', 'out', 'b'],
          ['a', 'out', 'join'],
          ['b', 'out', 'join']
        ]
      ),
      METRICS
    )

    expect(layout.nodes.map(({ id, rank }) => [id, rank])).toEqual([
      ['trigger', 0],
      ['a', 1],
      ['b', 2],
      ['join', 3]
    ])
  })

  it('lays out a cycle, an unreachable node and a dangling edge without throwing', () => {
    const layout = layoutGraph(
      graph(
        ['a', 'b', 'lonely'],
        [
          ['trigger', 'out', 'a'],
          ['a', 'out', 'b'],
          ['b', 'out', 'a'],
          ['a', 'out', 'missing']
        ]
      ),
      METRICS
    )

    expect(layout.nodes.map(({ id, rank }) => [id, rank])).toEqual([
      ['trigger', 0],
      ['a', 1],
      ['b', 1],
      ['lonely', 1]
    ])
    expect(layout.edges.map(({ from, to }) => `${from}->${to}`)).toEqual([
      'trigger->a',
      'a->b',
      'b->a'
    ])
  })

  it('places a lone trigger at the origin', () => {
    const layout = layoutGraph({ nodes: [], edges: [] }, METRICS)

    expect(layout).toEqual({
      width: 240,
      height: 60,
      nodes: [{ id: 'trigger', rank: 0, order: 0, x: 0, y: 0 }],
      edges: []
    })
  })
})
