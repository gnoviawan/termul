import type { Graph, NodeId, NodeKind } from '@shared/types/automation.types'
import { describe, expect, it } from 'vitest'
import { applyOps, isNodeId } from '../draft/apply-op'
import { OUTPUT_PORTS } from '../ports'
import { chainPort, NODE_KINDS, newNode, PALETTE_GROUPS } from './node-kinds'

const kinds = Object.keys(OUTPUT_PORTS).filter((kind) => kind !== 'trigger') as NodeKind[]

describe('node kinds', () => {
  it('offers every kind once, in a group, with a spec of that kind', () => {
    expect(PALETTE_GROUPS.flatMap((group) => group.kinds).sort()).toEqual([...kinds].sort())
    for (const kind of kinds) expect(NODE_KINDS[kind].spec().kind).toBe(kind)
  })

  it('names a new step with a free id and label, so add_node applies', () => {
    const graph: Graph = {
      nodes: [
        { id: 'http' as NodeId, label: 'HTTP', spec: NODE_KINDS.http.spec() },
        { id: 'http_2' as NodeId, label: 'Fetch', spec: NODE_KINDS.http.spec() }
      ],
      edges: []
    }
    const node = newNode('http', graph)
    expect(node).toMatchObject({ id: 'http_3', label: 'HTTP 3', spec: { kind: 'http' } })
    for (const kind of kinds) {
      const fresh = newNode(kind, graph)
      expect(isNodeId(fresh.id)).toBe(true)
      const doc = {
        name: 'x',
        trigger: { kind: 'manual' as const },
        isolation: 'shared_in_root' as const,
        graph
      }
      expect(applyOps(doc, [{ op: 'add_node', node: fresh }]).ok).toBe(true)
    }
  })

  it('chains a step on out, a condition on true, and a fail on nothing', () => {
    expect(chainPort('http')).toBe('out')
    expect(chainPort('for_each')).toBe('out')
    expect(chainPort('condition')).toBe('true')
    expect(chainPort('fail')).toBeNull()
  })
})
