import type { AutomationNode, Edge, Graph, NodeId, NodeSpec } from '@shared/types/automation.types'
import { describe, expect, it } from 'vitest'
import { fillHole, openHole, templateError, templateScope } from './template-scope'

const id = (value: string) => value as NodeId
const fail: NodeSpec = { kind: 'fail', message: 'x' }
const node = (nodeId: string, spec: NodeSpec = fail): AutomationNode => ({
  id: id(nodeId),
  label: nodeId.toUpperCase(),
  spec
})
const edge = (from: string, to: string, port: Edge['port'] = 'out'): Edge => ({
  from: from as Edge['from'],
  port,
  to: id(to)
})
const paths = (graph: Graph, nodeId: string) => templateScope(graph, id(nodeId)).map((s) => s.path)

describe('templateScope', () => {
  it('offers the trigger and every ancestor, never a descendant or an unrelated step', () => {
    const graph: Graph = {
      nodes: [node('a'), node('b'), node('c'), node('d'), node('side')],
      edges: [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'c', 'error'), edge('c', 'd')]
    }
    expect(paths(graph, 'c')).toEqual([
      'trigger.kind',
      'trigger.scheduled_for',
      'nodes.a.output',
      'nodes.b.output'
    ])
  })

  it("inside a for_each body offers the loop's item and index, not its output", () => {
    const loop = node('each', { kind: 'for_each', items: '', max_iterations: 5 })
    const graph: Graph = {
      nodes: [node('fetch'), loop, node('inner'), node('after')],
      edges: [
        edge('trigger', 'fetch'),
        edge('fetch', 'each'),
        edge('each', 'inner', 'item'),
        edge('each', 'after')
      ]
    }
    expect(paths(graph, 'inner')).toEqual([
      'trigger.kind',
      'trigger.scheduled_for',
      'nodes.fetch.output',
      'nodes.each.item',
      'nodes.each.index'
    ])
    expect(paths(graph, 'after')).toContain('nodes.each.output')
    expect(paths(graph, 'after')).not.toContain('nodes.each.item')
  })

  it("adds the fields of an agent's object output schema", () => {
    const agent = node('classify', {
      kind: 'agent',
      agent_id: 'claude-code',
      model: null,
      prompt: '',
      output_schema: { type: 'object', properties: { label: { type: 'string' } } },
      timeout_ms: 1000,
      max_attempts: 1,
      tools: []
    })
    const graph: Graph = { nodes: [agent, node('next')], edges: [edge('classify', 'next')] }
    expect(paths(graph, 'next')).toContain('nodes.classify.output.label')
  })
})

describe('templateError', () => {
  it('accepts what the host parses', () => {
    expect(templateError('plain')).toBeNull()
    expect(templateError('{{ nodes.fetch.output.items }} and {{trigger.kind}}')).toBeNull()
    expect(templateError('Bearer {{ secrets.API_TOKEN }}')).toBeNull()
    expect(templateError('{{ nodes.each.index }}')).toBeNull()
  })

  it('names what the host refuses', () => {
    expect(templateError('{{ nodes.fetch.output')).toBe('An opened {{ is never closed with }}')
    expect(templateError('{{ fetch.output }}')).toBe(
      '{{ fetch.output }}: root must be trigger, nodes or secrets'
    )
    expect(templateError('{{ trigger.at }}')).toBe(
      '{{ trigger.at }}: trigger exposes only scheduled_for and kind'
    )
    expect(templateError('{{ nodes.each.index.x }}')).toBe(
      '{{ nodes.each.index.x }}: nodes.<loop>.index has no fields'
    )
  })
})

describe('openHole and fillHole', () => {
  it('finds the unclosed hole before the caret and fills it in place', () => {
    expect(openHole('Hi {{ nodes.fe', 14)).toEqual({ start: 3, query: 'nodes.fe' })
    expect(openHole('Hi {{ nodes.fetch.output }} ', 28)).toBeNull()
    expect(openHole('no hole', 7)).toBeNull()
    expect(fillHole('Hi {{ nodes.fe }}!', 14, 3, 'nodes.fetch.output')).toEqual({
      text: 'Hi {{ nodes.fetch.output }}!',
      caret: 27
    })
  })
})
