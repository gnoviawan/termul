import type {
  AutomationRun,
  AutomationStep,
  Graph,
  NodeId,
  RunId
} from '@shared/types/automation.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWith } from '@/lib/test-utils/automation-fixtures'

const api = vi.hoisted(() => ({
  cancelAutomationRun: vi.fn(),
  decideAutomationApproval: vi.fn(),
  getAutomationRunSteps: vi.fn(),
  onAutomationChanged: vi.fn(() => () => {})
}))
vi.mock('@/lib/automation-api', () => api)
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => true
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
const copy = vi.hoisted(() => ({ copyTextWithToast: vi.fn(async () => true) }))
vi.mock('@/lib/copy-text', () => copy)
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))

/** Card renders per node id, to prove a poll that changes one card redraws only that card. */
const renders = vi.hoisted(() => new Map<string, number>())
vi.mock('../nodes/NodeCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nodes/NodeCard')>()
  return {
    ...actual,
    NodeCard: (props: Parameters<typeof actual.NodeCard>[0]) => {
      const key = props.data.kind === 'trigger' ? 'trigger' : props.data.node.id
      renders.set(key, (renders.get(key) ?? 0) + 1)
      return actual.NodeCard(props)
    }
  }
})

import { AutomationRunDetail } from '../../AutomationRunDetail'
import { stepOrder } from '../layout'
import { openingStep, runOverlay } from './run-overlay'

const ok = <T,>(data: T) => ({ success: true as const, data })
const id = (value: string): NodeId => value as NodeId

/** Fetch issues, then for each: classify, branch on it, label or note. Alert on a failed fetch. */
const graph: Graph = {
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
      spec: { kind: 'transform', fields: [{ name: 'kind', value: '{{nodes.each.item.kind}}' }] }
    },
    {
      id: id('is_bug'),
      label: 'Is bug',
      spec: { kind: 'condition', left: '{{nodes.classify.output.kind}}', op: 'eq', right: 'bug' }
    },
    { id: id('post'), label: 'Post label', spec: { kind: 'transform', fields: [] } },
    { id: id('note'), label: 'Note', spec: { kind: 'transform', fields: [] } },
    { id: id('summary'), label: 'Summary', spec: { kind: 'transform', fields: [] } }
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

const T0 = 1_773_046_800_000
const RUN = 'run-42' as RunId

const step = (
  node: string,
  iteration: number | null,
  status: AutomationStep['status'],
  extra: Partial<AutomationStep> = {}
): AutomationStep => ({
  run_id: RUN,
  node_id: id(node),
  iteration,
  status,
  output: null,
  error: null,
  // `executor.rs` records a skipped step with no start.
  started_at: status === 'skipped' ? null : T0,
  finished_at: status === 'running' || status === 'waiting' ? null : T0 + 400,
  wait_until: null,
  ...extra
})

const ISSUES = [{ kind: 'bug' }, { kind: 'question' }, { kind: 'bug' }]

/** Iterations 1 and 2 done (bug, then question); iteration 3 is classifying. */
const midRun: AutomationStep[] = [
  step('fetch', null, 'succeeded', { output: ISSUES, finished_at: T0 + 800 }),
  step('alert', null, 'skipped'),
  step('each', null, 'running'),
  step('classify', 0, 'succeeded', { output: { kind: 'bug' } }),
  step('is_bug', 0, 'succeeded', { output: { result: true } }),
  step('post', 0, 'succeeded'),
  step('note', 0, 'skipped'),
  step('classify', 1, 'succeeded', { output: { kind: 'question' } }),
  step('is_bug', 1, 'succeeded', { output: { result: false } }),
  step('post', 1, 'skipped'),
  step('note', 1, 'succeeded', { output: 'Not a bug.\nLeft for triage.' }),
  step('classify', 2, 'running')
]

/** The same run once iteration 3's classify failed: the loop and the run fail with it. */
const failedRun: AutomationStep[] = [
  ...midRun.filter((row) => !(row.node_id === 'classify' && row.iteration === 2)),
  step('classify', 2, 'failed', { error: 'template: nodes.each.item.kind is missing' }),
  step('is_bug', 2, 'skipped'),
  step('post', 2, 'skipped'),
  step('note', 2, 'skipped'),
  step('each', null, 'failed', {
    error: 'iteration 2: classify: template: nodes.each.item.kind is missing'
  }),
  step('summary', null, 'skipped')
].filter((row) => !(row.node_id === 'each' && row.status === 'running'))

const running = runWith({
  id: RUN,
  graph,
  status: 'running',
  finished_at: null,
  stop_reason: null,
  parked: null
})
const failed = runWith({
  id: RUN,
  graph,
  status: 'failed',
  finished_at: T0 + 2_000,
  stop_reason: 'each: iteration 2: classify: template: nodes.each.item.kind is missing',
  parked: null
})

function card(nodeId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`)
  if (!element) throw new Error(`no card for ${nodeId}`)
  return element
}

/** The status a card shows; a card not reached yet shows none. */
function cardStatus(nodeId: string): string | null {
  return within(card(nodeId)).queryByTestId('card-status')?.getAttribute('title') ?? null
}

function edgePath(key: string): Element {
  const path = document.querySelector(`.react-flow__edge[data-id="${key}"] .react-flow__edge-path`)
  if (!path) throw new Error(`no edge ${key}`)
  return path
}

function renderRun(run: AutomationRun, { phone = false, onChanged = vi.fn() } = {}) {
  render(
    <div style={{ height: 800 }}>
      <AutomationRunDetail
        run={run}
        automation={{ trigger: { kind: 'manual' }, layout: {} }}
        phone={phone}
        onClose={() => {}}
        onChanged={onChanged}
      />
    </div>
  )
  return onChanged
}

const steps = () => within(screen.getByRole('list', { name: 'Steps' }))
const inspector = () => within(screen.getByTestId('automation-inspector'))

beforeEach(() => {
  vi.clearAllMocks()
  renders.clear()
})
afterEach(() => vi.useRealTimers())

describe('the run canvas', () => {
  it('shows each step status on its card, the loop iterations, and which edges ran', async () => {
    api.getAutomationRunSteps.mockResolvedValue(ok(midRun))
    renderRun(running)

    await waitFor(() => expect(cardStatus('fetch')).toBe('Succeeded'))
    expect(cardStatus('trigger')).toBe('Succeeded')
    expect(cardStatus('alert')).toBe('Skipped')
    expect(cardStatus('each')).toBe('Running')
    expect(within(card('each')).getByTestId('card-iterations')).toHaveTextContent('3 iterations')
    // Body cards show the latest iteration, the one at work.
    expect(cardStatus('classify')).toBe('Running')
    expect(cardStatus('is_bug')).toBeNull()
    expect(cardStatus('summary')).toBeNull()

    expect(edgePath('trigger:out->fetch')).toHaveClass('[stroke-width:2.25]')
    expect(edgePath('fetch:error->alert')).toHaveClass('opacity-30')
    // Blue into the step at work, dashed: live.
    expect(edgePath('each:item->classify')).toHaveClass('text-primary')
    // Not decided yet: drawn as in the editor.
    expect(edgePath('each:out->summary')).not.toHaveClass('opacity-30')
    expect(edgePath('each:out->summary')).not.toHaveClass('[stroke-width:2.25]')

    expect(
      steps()
        .getAllByRole('button')
        .map((row) => row.getAttribute('aria-label'))
    ).toEqual([
      'Manual, Trigger, Succeeded',
      'Fetch issues, HTTP, Succeeded, 800 ms',
      'Alert, Fail, Skipped',
      'Each issue, For each, 3 iterations, Running',
      'Classify, Transform, iteration 3, ran in 3 of 3 iterations, Running',
      'Is bug, Condition, iteration 3, ran in 2 of 3 iterations, Not reached',
      'Post label, Transform, iteration 3, ran in 1 of 3 iterations, Not reached',
      'Note, Transform, iteration 3, ran in 1 of 3 iterations, Not reached',
      'Summary, Transform, Not reached'
    ])
  })

  it('shows the iteration picked in the inspector on every card in the loop body', async () => {
    api.getAutomationRunSteps.mockResolvedValue(ok(midRun))
    renderRun(running)
    await waitFor(() => expect(cardStatus('classify')).toBe('Running'))

    fireEvent.click(steps().getByRole('button', { name: /^Each issue/ }))
    const picker = within(inspector().getByRole('region', { name: 'Iteration' }))
    expect(
      picker.getByText('Iteration 3 of 3: Running. The steps in the loop show this iteration.')
    )
    expect(picker.getByRole('button', { name: 'Iteration 3, Running' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    fireEvent.click(picker.getByRole('button', { name: 'Iteration 1, Succeeded' }))
    expect(cardStatus('classify')).toBe('Succeeded')
    expect(cardStatus('is_bug')).toBe('Succeeded')
    expect(cardStatus('post')).toBe('Succeeded')
    expect(cardStatus('note')).toBe('Skipped')
    expect(edgePath('is_bug:true->post')).toHaveClass('[stroke-width:2.25]')
    expect(edgePath('is_bug:false->note')).toHaveClass('opacity-30')

    // A body step's inspector picks too, and shows its row in that iteration.
    fireEvent.click(steps().getByRole('button', { name: /^Note/ }))
    expect(inspector().getByTestId('inspector-status')).toHaveTextContent('Skipped')
    fireEvent.click(inspector().getByRole('button', { name: 'Iteration 2, Succeeded' }))
    expect(cardStatus('note')).toBe('Succeeded')
    expect(cardStatus('post')).toBe('Skipped')
    expect(inspector().getByTestId('inspector-status')).toHaveTextContent('Succeeded')
    expect(
      within(inspector().getByRole('region', { name: 'Output' })).getByText(/Left for triage/)
    ).toHaveTextContent('Not a bug. Left for triage.', { normalizeWhitespace: true })
  })

  it('inspects a step: status, timing, output as JSON that folds and copies', async () => {
    api.getAutomationRunSteps.mockResolvedValue(ok(midRun))
    renderRun(running)
    await waitFor(() => expect(cardStatus('fetch')).toBe('Succeeded'))

    fireEvent.click(card('fetch'))
    const panel = inspector()
    expect(panel.getByRole('heading', { name: 'Fetch issues' })).toBeInTheDocument()
    expect(panel.getByTestId('inspector-status')).toHaveTextContent('Succeeded')
    expect(panel.getByText('Duration').nextSibling).toHaveTextContent('800 ms')
    const output = within(panel.getByRole('region', { name: 'Output' }))
    expect(output.getByText(/"kind": "question"/)).toBeInTheDocument()

    fireEvent.click(output.getByRole('button', { name: 'Copy' }))
    expect(copy.copyTextWithToast).toHaveBeenCalledWith(
      JSON.stringify(ISSUES, null, 2),
      expect.objectContaining({ title: 'Output copied' })
    )
    fireEvent.click(output.getByRole('button', { name: 'Output' }))
    expect(output.queryByText(/"kind": "question"/)).toBeNull()

    fireEvent.click(panel.getByRole('button', { name: 'Close the inspector' }))
    expect(screen.queryByTestId('automation-inspector')).toBeNull()
  })

  it('shows a finished failed run: the failed iteration, its error, and the stop reason', async () => {
    api.getAutomationRunSteps.mockResolvedValue(ok(failedRun))
    renderRun(failed)

    await waitFor(() => expect(cardStatus('each')).toBe('Failed'))
    expect(screen.getByRole('heading', { level: 3, name: 'Failed' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull()
    expect(screen.getByText(failed.stop_reason as string)).toBeInTheDocument()
    expect(within(card('each')).getByTestId('card-iterations')).toHaveTextContent(
      '3 iterations · 1 failed'
    )
    expect(cardStatus('classify')).toBe('Failed')
    expect(cardStatus('summary')).toBe('Skipped')
    expect(edgePath('each:out->summary')).toHaveClass('opacity-30')

    fireEvent.click(card('classify'))
    expect(inspector().getByText('template: nodes.each.item.kind is missing')).toBeInTheDocument()
    expect(inspector().getByRole('button', { name: 'Iteration 3, Failed' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('follows a running run live and redraws only the cards whose status moved', async () => {
    vi.useFakeTimers()
    api.getAutomationRunSteps.mockResolvedValue(ok(midRun))
    renderRun(running)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(cardStatus('classify')).toBe('Running')
    const fetchRenders = renders.get('fetch')
    const classifyRenders = renders.get('classify') ?? 0

    api.getAutomationRunSteps.mockResolvedValue(
      ok([
        ...midRun.filter((row) => !(row.node_id === 'classify' && row.iteration === 2)),
        step('classify', 2, 'succeeded', { output: { kind: 'bug' } }),
        step('is_bug', 2, 'running')
      ])
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(cardStatus('classify')).toBe('Succeeded')
    expect(cardStatus('is_bug')).toBe('Running')
    expect(edgePath('classify:out->is_bug')).toHaveClass('text-primary')
    expect(renders.get('classify')).toBeGreaterThan(classifyRenders)
    expect(renders.get('fetch')).toBe(fetchRenders)
  })
})

describe('a run parked on an approval inside the loop', () => {
  const gated: Graph = {
    nodes: [
      {
        id: id('each'),
        label: 'Each issue',
        spec: { kind: 'for_each', items: '{{trigger.kind}}', max_iterations: 5 }
      },
      {
        id: id('gate'),
        label: 'Ship it?',
        spec: { kind: 'approval', message: 'Ship {{nodes.each.item}}?', timeout_ms: 3_600_000 }
      }
    ],
    edges: [
      { from: 'trigger', port: 'out', to: id('each') },
      { from: id('each'), port: 'item', to: id('gate') }
    ]
  }
  const UNTIL = T0 + 3_600_000
  const parked = runWith({
    id: RUN,
    graph: gated,
    status: 'running',
    finished_at: null,
    stop_reason: null,
    parked: { node_id: id('gate'), iteration: 1, until: UNTIL }
  })

  it('opens on the waiting step with the decide actions, only in the iteration that waits', async () => {
    api.getAutomationRunSteps.mockResolvedValue(
      ok([
        step('each', null, 'running'),
        step('gate', 0, 'succeeded', {
          output: { message: 'Ship a?', decision: 'approved', decided_at: T0 + 100 }
        }),
        step('gate', 1, 'waiting', { output: { message: 'Ship b?' }, wait_until: UNTIL })
      ])
    )
    api.decideAutomationApproval.mockResolvedValue(ok(true))
    const onChanged = renderRun(parked)

    const card = within(await screen.findByRole('region', { name: 'Ship it?' }))
    await waitFor(() => expect(card.getByText('Ship b?')).toBeInTheDocument())
    expect(screen.getByRole('heading', { level: 3, name: 'Waiting for approval' }))
    expect(cardStatus('gate')).toBe('Waiting')

    fireEvent.click(inspector().getByRole('button', { name: 'Iteration 1, Succeeded' }))
    expect(screen.queryByRole('region', { name: 'Ship it?' })).toBeNull()
    expect(inspector().getByText('Approved')).toHaveClass('text-success')
    expect(cardStatus('gate')).toBe('Succeeded')

    fireEvent.click(inspector().getByRole('button', { name: 'Iteration 2, Waiting' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    })
    expect(api.decideAutomationApproval).toHaveBeenCalledWith(RUN, 'gate', true)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('on the phone, the inspector sheet takes the step list place', async () => {
    api.getAutomationRunSteps.mockResolvedValue(ok([step('each', null, 'running')]))
    renderRun({ ...parked, parked: null }, { phone: true })
    await waitFor(() => expect(cardStatus('each')).toBe('Running'))

    fireEvent.click(steps().getByRole('button', { name: /^Each issue/ }))
    expect(screen.queryByRole('list', { name: 'Steps' })).toBeNull()
    expect(inspector().getByText('No iteration has run.')).toBeInTheDocument()
    fireEvent.click(inspector().getByRole('button', { name: 'Close the inspector' }))
    expect(screen.getByRole('list', { name: 'Steps' })).toBeInTheDocument()
  })
})

describe('the step a run opens on', () => {
  const open = (run: AutomationRun, rows: AutomationStep[]) =>
    openingStep(runOverlay(run, rows, {}), stepOrder(run.graph))

  it('is the failed step inside the loop rather than the loop it failed', () => {
    expect(open(failed, failedRun)).toBe('classify')
  })

  it('is the step at work in a running run', () => {
    expect(open(running, midRun)).toBe('classify')
  })

  it('is a step waiting on a park', () => {
    expect(
      open(running, [
        step('fetch', null, 'succeeded'),
        step('each', null, 'running'),
        step('classify', 0, 'waiting')
      ])
    ).toBe('classify')
  })

  it('is none for a run that succeeded: it opens on the trigger', () => {
    expect(
      open(
        { ...failed, status: 'succeeded' },
        midRun.map((row) => (row.status === 'running' ? { ...row, status: 'succeeded' } : row))
      )
    ).toBeNull()
  })
})
