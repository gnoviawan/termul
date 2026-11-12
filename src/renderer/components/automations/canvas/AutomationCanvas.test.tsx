import type { Automation, AutomationLayout, NodeId } from '@shared/types/automation.types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fixtureAutomation } from '@/lib/test-utils/automation-fixtures'
import { AutomationCanvas } from './AutomationCanvas'

type Shown = Pick<Automation, 'graph' | 'trigger' | 'layout'>

const id = (value: string): NodeId => value as NodeId

const triage: Shown = {
  trigger: { kind: 'manual' },
  layout: {},
  graph: {
    nodes: [
      {
        id: id('fetch'),
        label: 'Fetch issues',
        spec: {
          kind: 'http',
          method: 'GET',
          url: 'https://api.github.com/issues',
          headers: [],
          body: null,
          timeout_ms: 10_000,
          max_attempts: 1,
          allowed_hosts: ['api.github.com']
        }
      },
      { id: id('alert'), label: 'Alert', spec: { kind: 'fail', message: 'fetch failed' } },
      {
        id: id('each'),
        label: 'Each issue',
        spec: { kind: 'for_each', items: '{{nodes.fetch.output}}', max_iterations: 50 }
      },
      {
        id: id('classify'),
        label: 'Classify',
        spec: {
          kind: 'agent',
          agent_id: 'claude-code',
          model: 'sonnet',
          prompt: 'Label it',
          output_schema: { kind: 'string' },
          timeout_ms: 120_000,
          max_attempts: 3,
          tools: ['read', 'search']
        }
      },
      {
        id: id('is_bug'),
        label: 'Is bug',
        spec: { kind: 'condition', left: '{{nodes.classify.output}}', op: 'eq', right: 'bug' }
      },
      {
        id: id('post'),
        label: 'Post label',
        spec: {
          kind: 'mcp_tool',
          server_id: 'github',
          tool: 'add_labels',
          arguments: [],
          timeout_ms: 60_000
        }
      },
      {
        id: id('note'),
        label: 'Note',
        spec: {
          kind: 'transform',
          fields: [
            { name: 'title', value: 'x' },
            { name: 'kind', value: 'y' }
          ]
        }
      },
      { id: id('summary'), label: 'Summary', spec: { kind: 'wait', duration_ms: 60_000 } }
    ],
    edges: [
      { from: 'trigger', port: 'out', to: id('fetch') },
      { from: id('fetch'), port: 'out', to: id('each') },
      { from: id('fetch'), port: 'error', to: id('alert') },
      { from: id('each'), port: 'item', to: id('classify') },
      { from: id('each'), port: 'out', to: id('summary') },
      { from: id('classify'), port: 'out', to: id('is_bug') },
      { from: id('is_bug'), port: 'true', to: id('post') },
      { from: id('is_bug'), port: 'false', to: id('note') }
    ]
  }
}

function card(nodeId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`)
  if (!element) throw new Error(`no card for ${nodeId}`)
  return element
}

/** Where a card sits on the canvas, read from the transform React Flow paints. */
function positionOf(nodeId: string): { x: number; y: number } {
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(card(nodeId).style.transform)
  if (!match) throw new Error(`no position on ${nodeId}: ${card(nodeId).style.transform}`)
  return { x: Number(match[1]), y: Number(match[2]) }
}

function withLayout(layout: AutomationLayout): Shown {
  return { ...triage, layout }
}

describe('AutomationCanvas', () => {
  it('draws every step as a card with its kind, short detail and config slots', () => {
    render(<AutomationCanvas automation={triage} phone={false} />)

    expect(within(card('trigger')).getByText('Manual')).toBeInTheDocument()
    expect(within(card('trigger')).getByText('Run manually')).toBeInTheDocument()
    expect(within(card('fetch')).getByText('HTTP · GET api.github.com')).toBeInTheDocument()
    expect(within(card('each')).getByText('For each · max 50')).toBeInTheDocument()
    expect(within(card('note')).getByText('Transform · 2 fields')).toBeInTheDocument()

    const classify = within(card('classify'))
    expect(classify.getByText('Classify')).toBeInTheDocument()
    expect(classify.getByText('Agent · claude-code')).toBeInTheDocument()
    expect(classify.getByText('sonnet')).toBeInTheDocument()
    expect(classify.getByText('read, search')).toBeInTheDocument()
    expect(classify.getByText('Model')).toBeInTheDocument()
    expect(classify.getByText('Tools')).toBeInTheDocument()

    const post = within(card('post'))
    expect(post.getByText('github')).toBeInTheDocument()
    expect(post.getByText('add_labels')).toBeInTheDocument()
    expect(post.getByText('Server')).toBeInTheDocument()
    expect(post.getByText('Tool')).toBeInTheDocument()
  })

  it('names loop, branch and error ports, and leaves the plain next edge unnamed', () => {
    render(<AutomationCanvas automation={triage} phone={false} />)

    expect(screen.getByTestId('edge-label-each:item->classify')).toHaveTextContent('item')
    expect(screen.getByTestId('edge-label-is_bug:true->post')).toHaveTextContent('true')
    expect(screen.getByTestId('edge-label-is_bug:false->note')).toHaveTextContent('false')
    expect(screen.queryByTestId('edge-label-fetch:out->each')).toBeNull()
    expect(screen.queryByTestId('edge-label-fetch:error->alert')).toBeNull()
    // `error` is named beside its handle, on every step that has one.
    expect(within(card('fetch')).getByText('error')).toBeInTheDocument()
    expect(within(card('is_bug')).getByText('error')).toBeInTheDocument()
    expect(within(card('alert')).queryByText('error')).toBeNull()
    expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(8)
  })

  it('draws an approval step with its timeout and an error port', () => {
    const gated: Shown = {
      trigger: { kind: 'manual' },
      layout: {},
      graph: {
        nodes: [
          {
            id: id('gate'),
            label: 'Ship it?',
            spec: {
              kind: 'approval',
              message: 'Ship {{nodes.trigger.output}}?',
              timeout_ms: 3_600_000
            }
          }
        ],
        edges: [{ from: 'trigger', port: 'out', to: id('gate') }]
      }
    }
    render(<AutomationCanvas automation={gated} phone={false} />)

    const gate = within(card('gate'))
    expect(gate.getByText('Ship it?')).toBeInTheDocument()
    expect(gate.getByText(/^Approval · times out after /)).toBeInTheDocument()
    expect(gate.getByText('error')).toBeInTheDocument()
  })

  it('reads out every step and branch as a list', () => {
    render(<AutomationCanvas automation={fixtureAutomation} phone={false} />)

    const steps = within(screen.getByRole('list', { name: 'Automation steps' }))
    expect(steps.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Trigger: Cron 0 5 * * 1-5 (America/New_York). Next: Fetch items',
      'Fetch items, HTTP: GET api.example.com. Next: Extract. On error: Fetch failed',
      'Extract, Agent: claude · sonnet. Next: Urgent?',
      'Urgent?, Condition: {{nodes.extract.output.urgent}} eq true. If true: Shape',
      'Shape, Transform: text. Next: Notify',
      'Notify, HTTP: POST hooks.example.com',
      'Fetch failed, Fail: fetch failed'
    ])
  })

  it('lays out an unplaced graph left to right in run order', () => {
    render(<AutomationCanvas automation={triage} phone={false} />)

    const x = (nodeId: string): number => positionOf(nodeId).x
    expect(x('trigger')).toBeLessThan(x('fetch'))
    expect(x('fetch')).toBeLessThan(x('each'))
    expect(x('fetch')).toBeLessThan(x('alert'))
    expect(x('each')).toBeLessThan(x('classify'))
    expect(x('classify')).toBeLessThan(x('is_bug'))
    expect(x('is_bug')).toBeLessThan(x('post'))
    expect(x('post')).toBe(x('note'))
    expect(positionOf('post').y).not.toBe(positionOf('note').y)
  })

  it('keeps stored positions and places a new step beside the step it follows', () => {
    const auto = render(<AutomationCanvas automation={triage} phone={false} />)
    const step = positionOf('each').x - positionOf('fetch').x
    const below = positionOf('alert').y - positionOf('fetch').y
    auto.unmount()

    render(
      <AutomationCanvas
        automation={withLayout({
          trigger: { x: -500, y: 900 },
          fetch: { x: 1000, y: 2000 },
          classify: { x: 40, y: -300 }
        })}
        phone={false}
      />
    )

    expect(positionOf('trigger')).toEqual({ x: -500, y: 900 })
    expect(positionOf('fetch')).toEqual({ x: 1000, y: 2000 })
    expect(positionOf('classify')).toEqual({ x: 40, y: -300 })
    // Unplaced children keep their auto-layout offset from a placed parent.
    expect(positionOf('each').x).toBe(1000 + step)
    expect(positionOf('alert').y).toBe(2000 + below)
    expect(positionOf('is_bug').x).toBeGreaterThan(40)
  })

  it('keeps the selection and untouched cards when the host sends an update', () => {
    const view = render(<AutomationCanvas automation={triage} phone={false} />)
    fireEvent.click(within(card('classify')).getByText('Classify'))
    expect(card('classify')).toHaveClass('selected')
    const fetchCard = within(card('fetch')).getByText('Fetch issues')

    view.rerender(
      <AutomationCanvas
        automation={{
          ...triage,
          graph: {
            ...triage.graph,
            nodes: triage.graph.nodes.map((node) =>
              node.id === 'note' ? { ...node, label: 'Write note' } : node
            )
          }
        }}
        phone={false}
      />
    )

    expect(within(card('note')).getByText('Write note')).toBeInTheDocument()
    expect(card('classify')).toHaveClass('selected')
    expect(within(card('fetch')).getByText('Fetch issues')).toBe(fetchCard)
  })

  it('offers fit and zoom controls, and no editing', () => {
    render(<AutomationCanvas automation={triage} phone />)

    const controls = within(screen.getByRole('toolbar', { name: 'Diagram view' }))
    expect(
      controls.getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    ).toEqual(['Fit to view', 'Zoom in', 'Zoom out'])
    expect(document.querySelector('.react-flow__handle.connectable')).toBeNull()
    expect(document.querySelector('.react-flow__node.draggable')).toBeNull()
  })
})
