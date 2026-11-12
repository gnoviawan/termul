import type { AgentTool, Graph, NodeSpec } from '@shared/types/automation.types'
import { describe, expect, it } from 'vitest'
import { fixtureAutomation } from '@/lib/test-utils/automation-fixtures'
import { agentToolRules } from './agent-tools'

// The cases below are `graph_tests.rs` rule8 and rule9 on the same graphs:
// the shared fixture is `test_support::sample_automation`.
const sample = fixtureAutomation.graph

const agent = (prompt: string, tools: AgentTool[] = []): NodeSpec => ({
  kind: 'agent',
  agent_id: 'claude',
  model: null,
  prompt,
  output_schema: { type: 'object' },
  timeout_ms: 1000,
  max_attempts: 1,
  tools
})

function withSpec(graph: Graph, id: string, spec: NodeSpec): Graph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, spec } : n)) }
}

function rulesOf(graph: Graph, id: string) {
  const node = graph.nodes.find((n) => n.id === id)
  if (node?.spec.kind !== 'agent') throw new Error(`${id} is not an agent`)
  return agentToolRules(graph, id, node.spec.tools)
}

/** `graph_tests::loop_automation`. */
const loop: Graph = {
  nodes: [
    {
      id: 'fetch',
      label: '',
      spec: {
        kind: 'http',
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: [],
        body: null,
        allowed_hosts: ['api.example.com']
      }
    },
    {
      id: 'each',
      label: '',
      spec: { kind: 'for_each', items: '{{nodes.fetch.output.body.items}}', max_iterations: 10 }
    },
    {
      id: 'post',
      label: '',
      spec: {
        kind: 'http',
        method: 'POST',
        url: 'https://api.example.com/items/{{nodes.each.index}}',
        headers: [],
        body: '{{nodes.each.item}}',
        allowed_hosts: ['api.example.com']
      }
    },
    { id: 'mark', label: '', spec: { kind: 'transform', fields: [] } },
    { id: 'done', label: '', spec: { kind: 'transform', fields: [] } }
  ],
  edges: [
    { from: 'trigger', port: 'out', to: 'fetch' },
    { from: 'fetch', port: 'out', to: 'each' },
    { from: 'each', port: 'item', to: 'post' },
    { from: 'post', port: 'out', to: 'mark' },
    { from: 'each', port: 'out', to: 'done' }
  ]
} as Graph

describe('agentToolRules', () => {
  it('rule8: untrusted data reaching an agent with an http step after it is an untrusted flow', () => {
    expect(rulesOf(sample, 'extract')).toEqual({
      untrustedPrompt: [],
      outboundFiles: null,
      untrustedFlow: true
    })
    expect(
      rulesOf(withSpec(sample, 'extract', agent('Summarize {{trigger.kind}}')), 'extract')
    ).toEqual({ untrustedPrompt: [], outboundFiles: null, untrustedFlow: false })
    expect(
      rulesOf(
        withSpec(sample, 'extract', agent('Summarize {{trigger.kind}}', ['fetch'])),
        'extract'
      ).untrustedFlow
    ).toBe(true)
    const noPost = { ...sample, nodes: sample.nodes.filter((n) => n.id !== 'post') }
    expect(rulesOf(noPost, 'extract').untrustedFlow).toBe(false)
  })

  it('rule9: a prompt reading untrusted data may not send out or edit, and outbound tools exclude file tools', () => {
    const all = withSpec(
      sample,
      'extract',
      agent('Summarize {{nodes.fetch.output.items}}', ['read', 'execute', 'edit', 'fetch', 'other'])
    )
    expect(rulesOf(all, 'extract')).toMatchObject({
      untrustedPrompt: ['execute', 'edit', 'fetch', 'other'],
      outboundFiles: { outbound: ['fetch', 'other'], files: ['read', 'edit'] }
    })
    const reading = withSpec(
      sample,
      'extract',
      agent('Summarize {{nodes.fetch.output.items}}', ['read', 'search'])
    )
    expect(rulesOf(reading, 'extract')).toMatchObject({ untrustedPrompt: [], outboundFiles: null })
  })

  it('rule9: run commands may sit beside file tools; fetch may not', () => {
    const commandLine = withSpec(
      sample,
      'extract',
      agent('Run the tests for {{trigger.kind}}', ['execute', 'read', 'search', 'edit'])
    )
    expect(rulesOf(commandLine, 'extract')).toMatchObject({
      untrustedPrompt: [],
      outboundFiles: null
    })
    const fetching = withSpec(
      sample,
      'extract',
      agent('Look up {{trigger.kind}}', ['execute', 'fetch', 'read'])
    )
    expect(rulesOf(fetching, 'extract').outboundFiles).toEqual({
      outbound: ['fetch'],
      files: ['read']
    })
  })

  it('rule9: an agent that reaches out taints the agents reading its output', () => {
    const base = withSpec(sample, 'extract', agent('Look up {{trigger.kind}}', ['fetch']))
    const withWriter: Graph = {
      nodes: [
        ...base.nodes,
        {
          id: 'writer',
          label: 'Write',
          spec: agent('Save {{nodes.extract.output.summary}}', ['edit'])
        }
      ],
      edges: [...base.edges, { from: 'check', port: 'false', to: 'writer' }]
    } as Graph
    expect(rulesOf(withWriter, 'writer').untrustedPrompt).toEqual(['edit'])
  })

  it('rule9: untrusted data reaches an agent through a loop item, but not through the index', () => {
    const inBody = withSpec(loop, 'mark', agent('Save {{nodes.each.item.name}}', ['edit']))
    expect(rulesOf(inBody, 'mark').untrustedPrompt).toEqual(['edit'])
    const indexOnly = withSpec(loop, 'mark', agent('Item {{nodes.each.index}}', ['edit']))
    expect(rulesOf(indexOnly, 'mark').untrustedPrompt).toEqual([])
  })

  it('a template the host refuses reads nothing', () => {
    const broken = withSpec(
      sample,
      'extract',
      agent('Summarize {{nodes.fetch.output.items', ['fetch'])
    )
    expect(rulesOf(broken, 'extract').untrustedPrompt).toEqual([])
  })

  it('rules run on the tools being set, not the stored ones', () => {
    expect(agentToolRules(sample, 'extract', ['fetch']).untrustedPrompt).toEqual(['fetch'])
  })
})
