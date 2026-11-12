import type {
  AutomationRun,
  AutomationStep,
  Graph,
  NodeId,
  RunId
} from '@shared/types/automation.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detailWith, runWith } from '@/lib/test-utils/automation-fixtures'
import { expectWriteGated } from '@/lib/test-utils/write-gate'

const api = vi.hoisted(() => ({
  cancelAutomationRun: vi.fn(),
  decideAutomationApproval: vi.fn(),
  getAutomationRunSteps: vi.fn(),
  markAutomationSeen: vi.fn(),
  onAutomationChanged: vi.fn(() => () => {})
}))
vi.mock('@/lib/automation-api', () => api)
const writes = vi.hoisted(() => ({ admitted: true }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => writes.admitted
}))
const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { AutomationDetail } from './AutomationDetail'
import { AutomationRunDetail } from './AutomationRunDetail'
import { formatDateTime } from './automation-format'
import { AutomationCanvas } from './canvas/AutomationCanvas'

const ok = <T,>(data: T) => ({ success: true as const, data })

const GATE = 'gate' as NodeId
const graph: Graph = {
  nodes: [
    {
      id: GATE,
      label: 'Ship it?',
      spec: { kind: 'approval', message: 'Deploy {{trigger.kind}}?', timeout_ms: 3_600_000 }
    },
    {
      id: 'notify' as NodeId,
      label: 'Notify',
      spec: { kind: 'transform', fields: [{ name: 'text', value: 'shipped' }] }
    }
  ],
  edges: [
    { from: 'trigger', port: 'out', to: GATE },
    { from: GATE, port: 'out', to: 'notify' as NodeId }
  ]
}
const STARTED = 1_773_046_800_000
const UNTIL = STARTED + 3_600_000

const parkedRun = (overrides: Partial<AutomationRun> = {}): AutomationRun =>
  runWith({
    id: 'run-7' as RunId,
    graph,
    status: 'running',
    finished_at: null,
    stop_reason: null,
    parked: { node_id: GATE, iteration: null, until: UNTIL },
    ...overrides
  })

const gateStep = (overrides: Partial<AutomationStep> = {}): AutomationStep => ({
  run_id: 'run-7' as RunId,
  node_id: GATE,
  iteration: null,
  status: 'waiting',
  output: { message: 'Deploy manual?\nTwo files changed.' },
  error: null,
  started_at: STARTED,
  finished_at: null,
  wait_until: UNTIL,
  ...overrides
})

beforeEach(() => {
  vi.clearAllMocks()
  writes.admitted = true
  api.getAutomationRunSteps.mockResolvedValue(ok([gateStep()]))
})

const renderRun = (run: AutomationRun, onChanged = vi.fn()) => {
  render(
    <AutomationRunDetail
      run={run}
      automation={{ trigger: { kind: 'manual' }, layout: {} }}
      phone={false}
      onClose={() => {}}
      onChanged={onChanged}
    />
  )
  return onChanged
}

const stepRows = (): (string | null)[] =>
  within(screen.getByRole('list', { name: 'Steps' }))
    .getAllByRole('button')
    .map((row) => row.getAttribute('aria-label'))

/** The inspector, opened on `label`'s step from the step list. */
const inspect = (label: string) => {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label.replace('?', '\\?')}`) }))
  return within(screen.getByTestId('automation-inspector'))
}

const approveEnabled = () =>
  waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled())

describe('a run parked on an approval', () => {
  it('shows the rendered message, the deadline and the decision buttons', async () => {
    renderRun(parkedRun())

    const card = within(await screen.findByRole('region', { name: 'Ship it?' }))
    await waitFor(() =>
      expect(card.getByText(/Deploy manual\?/)).toHaveTextContent(
        'Deploy manual? Two files changed.',
        { normalizeWhitespace: true }
      )
    )
    expect(card.getByText(`Expires ${formatDateTime(UNTIL)}`)).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(card.getByRole('button', { name: 'Reject' })).toBeEnabled()
    expect(
      screen.getByRole('heading', { level: 3, name: 'Waiting for approval' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeEnabled()
    expect(stepRows()).toEqual([
      'Manual, Trigger, Succeeded',
      'Ship it?, Approval, Waiting',
      'Notify, Transform, Not reached'
    ])
    // The run opens on the step it waits on.
    const inspector = within(screen.getByTestId('automation-inspector'))
    expect(inspector.getByText('Waiting for approval until').nextSibling).toHaveTextContent(
      formatDateTime(UNTIL)
    )
  })

  it('approves through the facade, holds both buttons while pending, then refreshes', async () => {
    let reply: (value: unknown) => void = () => {}
    api.decideAutomationApproval.mockReturnValue(
      new Promise((resolve) => {
        reply = resolve
      })
    )
    const onChanged = renderRun(parkedRun())
    await approveEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(api.decideAutomationApproval).toHaveBeenCalledWith('run-7', 'gate', true)
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled()
    await act(async () => reply(ok(true)))
    expect(onChanged).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(api.getAutomationRunSteps).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('holds Approve until the message loads, but lets the run be rejected', async () => {
    api.getAutomationRunSteps.mockReturnValue(new Promise(() => {}))
    renderRun(parkedRun())

    const card = within(await screen.findByRole('region', { name: 'Ship it?' }))
    expect(card.getByText('Loading the message…')).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(card.getByRole('button', { name: 'Reject' })).toBeEnabled()
  })

  it('says when the message failed to load and retries it, still holding Approve', async () => {
    api.getAutomationRunSteps.mockResolvedValueOnce({
      success: false,
      error: 'host offline',
      code: 'NETWORK'
    })
    renderRun(parkedRun())

    const card = within(await screen.findByRole('region', { name: 'Ship it?' }))
    await waitFor(() =>
      expect(
        card.getByText('The message did not load, so it cannot be approved yet.')
      ).toBeInTheDocument()
    )
    expect(card.queryByText('Loading the message…')).not.toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(card.getByRole('button', { name: 'Reject' })).toBeEnabled()

    fireEvent.click(card.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(card.getByText(/Deploy manual\?/)).toBeInTheDocument())
    expect(api.getAutomationRunSteps).toHaveBeenCalledTimes(2)
    expect(card.getByRole('button', { name: 'Approve' })).toBeEnabled()
  })

  it('says so when the run had already moved on, and refreshes', async () => {
    api.decideAutomationApproval.mockResolvedValue(ok(false))
    const onChanged = renderRun(parkedRun())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    })

    expect(api.decideAutomationApproval).toHaveBeenCalledWith('run-7', 'gate', false)
    expect(toast.info).toHaveBeenCalledWith('This run is no longer waiting for approval.')
    expect(toast.error).not.toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('re-enables the buttons and reports a failed decision', async () => {
    api.decideAutomationApproval.mockResolvedValue({
      success: false,
      error: 'host offline',
      code: 'NETWORK'
    })
    const onChanged = renderRun(parkedRun())
    await approveEnabled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    })

    expect(toast.error).toHaveBeenCalledWith('Could not record the decision: host offline')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('gates both decisions on a server that refuses remote writes', async () => {
    writes.admitted = false
    renderRun(parkedRun())

    await within(await screen.findByRole('region', { name: 'Ship it?' })).findByText(
      /Deploy manual\?/
    )
    expectWriteGated(screen.getByRole('button', { name: 'Approve' }))
    expectWriteGated(screen.getByRole('button', { name: 'Reject' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(api.decideAutomationApproval).not.toHaveBeenCalled()
  })

  it('shows the message of the iteration the run is parked in', async () => {
    api.getAutomationRunSteps.mockResolvedValue(
      ok([
        gateStep({
          iteration: 0,
          status: 'succeeded',
          output: { message: 'Ship a?', decision: 'approved', decided_at: STARTED },
          finished_at: STARTED
        }),
        gateStep({ iteration: 1, output: { message: 'Ship b?' } })
      ])
    )
    renderRun(parkedRun({ parked: { node_id: GATE, iteration: 1, until: UNTIL } }))

    const card = within(await screen.findByRole('region', { name: 'Ship it?' }))
    await waitFor(() => expect(card.getByText('Ship b?')).toBeInTheDocument())
  })

  it('shows the decision on the step once the run moved on, and no card', async () => {
    api.getAutomationRunSteps.mockResolvedValue(
      ok([
        gateStep({
          status: 'failed',
          output: { message: 'Deploy manual?', decision: 'rejected', decided_at: UNTIL },
          error: 'rejected',
          finished_at: UNTIL
        })
      ])
    )
    renderRun(parkedRun({ status: 'failed', finished_at: UNTIL, parked: null }))

    await waitFor(() => expect(stepRows()[1]).toBe('Ship it?, Approval, Failed, 1 h'))
    const inspector = inspect('Ship it?')
    expect(inspector.getByText('Rejected')).toHaveClass('text-destructive')
    expect(inspector.getByText(`· ${formatDateTime(UNTIL)}`, { exact: false })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Ship it?' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull()
  })

  it('keeps a cancelled approval on its error, with its message in the output', async () => {
    api.getAutomationRunSteps.mockResolvedValue(
      ok([gateStep({ status: 'failed', error: 'cancelled', finished_at: STARTED + 5_000 })])
    )
    renderRun(parkedRun({ status: 'cancelled', finished_at: STARTED + 5_000, parked: null }))

    await waitFor(() => expect(stepRows()[1]).toBe('Ship it?, Approval, Cancelled, 5 s'))
    const inspector = inspect('Ship it?')
    expect(inspector.getByText('cancelled')).toHaveClass('text-destructive')
    expect(inspector.getByText(/"message": "Deploy manual\?/)).toBeInTheDocument()
  })

  it('shows no card for a run parked on a wait', async () => {
    const pause = 'pause' as NodeId
    api.getAutomationRunSteps.mockResolvedValue(ok([gateStep({ node_id: pause, output: null })]))
    renderRun(
      parkedRun({
        graph: {
          nodes: [{ id: pause, label: 'Pause', spec: { kind: 'wait', duration_ms: 3_600_000 } }],
          edges: [{ from: 'trigger', port: 'out', to: pause }]
        },
        parked: { node_id: pause, iteration: null, until: UNTIL }
      })
    )

    await waitFor(() => expect(stepRows()[1]).toBe('Pause, Wait, Waiting'))
    const inspector = inspect('Pause')
    expect(inspector.getByText('Waiting until').nextSibling).toHaveTextContent(
      formatDateTime(UNTIL)
    )
    expect(screen.getByRole('heading', { level: 3, name: 'Running' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })
})

describe('the automation of a run parked on an approval', () => {
  const props = {
    detail: detailWith(),
    narrow: false,
    isVisible: true,
    onDeleted: () => {},
    onChanged: () => {}
  }

  it('points at the parked run and lists it as waiting for approval', () => {
    const onOpenRun = vi.fn()
    render(<AutomationDetail {...props} runs={[parkedRun(), runWith()]} onOpenRun={onOpenRun} />)

    expect(screen.getByText('A run is waiting for your approval.')).toBeInTheDocument()
    expect(screen.getByText('Waiting for approval')).toHaveClass('text-warning')
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onOpenRun).toHaveBeenCalledWith('run-7')
  })

  it('shows no banner when no run waits for an approval', () => {
    render(<AutomationDetail {...props} runs={[runWith()]} onOpenRun={() => {}} />)

    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.queryByText('A run is waiting for your approval.')).toBeNull()
  })

  it('draws an approval node with its message as the key detail', () => {
    render(
      <AutomationCanvas
        automation={{ graph, trigger: { kind: 'manual' }, layout: {} }}
        phone={false}
      />
    )

    const steps = within(screen.getByRole('list', { name: 'Automation steps' }))
    expect(steps.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Trigger: Run manually. Next: Ship it?',
      'Ship it?, Approval: Deploy {{trigger.kind}}?. Next: Notify',
      'Notify, Transform: text'
    ])
  })
})
