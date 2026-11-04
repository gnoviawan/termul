import type {
  AutomationId,
  AutomationRun,
  Graph,
  Issue,
  NodeId,
  RunId
} from '@shared/types/automation.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  automationWith,
  detailWith,
  fixtureAutomation,
  fixturePolicy,
  fixtureSteps,
  runWith
} from '@/lib/test-utils/automation-fixtures'

const api = vi.hoisted(() => ({
  approveAutomation: vi.fn(),
  cancelAutomationRun: vi.fn(),
  decideAutomationApproval: vi.fn(),
  deleteAutomation: vi.fn(),
  deleteAutomationSecret: vi.fn(),
  getAutomationRunSteps: vi.fn(),
  listAutomationSecrets: vi.fn(),
  markAutomationSeen: vi.fn(),
  onAutomationChanged: vi.fn(() => () => {}),
  runAutomationNow: vi.fn(),
  setAutomationEnabled: vi.fn(),
  setAutomationSecret: vi.fn()
}))
vi.mock('@/lib/automation-api', () => api)
const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { AutomationDetail } from './AutomationDetail'
import { AutomationDiagram } from './AutomationDiagram'
import { AutomationList, EMPTY_EXAMPLE } from './AutomationList'
import { AutomationRunDetail } from './AutomationRunDetail'
import { AutomationSecretsDialog } from './AutomationSecretsDialog'
import { formatDateTime } from './automation-format'
import { RunPolicyCard } from './RunPolicyCard'

const ok = <T,>(data: T) => ({ success: true as const, data })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AutomationList', () => {
  it('shows each automation with its state, trigger, last run and unseen failures', () => {
    render(
      <AutomationList
        automations={[
          fixtureAutomation,
          automationWith({
            id: 'auto-2' as AutomationId,
            name: 'Draft',
            approved_revision: null,
            trigger: { kind: 'manual' },
            next_run_at: null,
            unseen_failures: 0,
            last_run: null
          }),
          automationWith({
            id: 'auto-3' as AutomationId,
            name: 'Paused',
            enabled: false,
            unseen_failures: 0
          })
        ]}
        selectedId={null}
        onSelect={() => {}}
      />
    )

    const [digest, draft, paused] = screen.getAllByRole('button')
    expect(within(digest).getByText('Morning digest')).toBeInTheDocument()
    expect(within(digest).getByText('Armed')).toBeInTheDocument()
    expect(within(digest).getByTestId('unseen-failures')).toHaveTextContent('2 new failures')
    expect(within(digest).getByText('Cron 0 5 * * 1-5 (America/New_York)')).toBeInTheDocument()
    expect(within(digest).getByText('failed')).toHaveClass('text-destructive')
    expect(within(draft).getByText('Needs approval')).toBeInTheDocument()
    expect(within(draft).getByText('Run manually')).toBeInTheDocument()
    expect(within(draft).getByText('No next run')).toBeInTheDocument()
    expect(within(draft).getByText('Never run')).toBeInTheDocument()
    expect(within(draft).queryByTestId('unseen-failures')).toBeNull()
    expect(within(paused).getByText('Disabled')).toBeInTheDocument()
  })

  it('tells the user to ask an agent when there are none', () => {
    render(<AutomationList automations={[]} selectedId={null} onSelect={() => {}} />)

    expect(screen.getByText('No automations yet')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(EMPTY_EXAMPLE))).toBeInTheDocument()
  })
})

describe('RunPolicyCard', () => {
  const issue: Issue = {
    node_id: 'post' as NodeId,
    code: 'host_not_allowed',
    message: 'host not allowed'
  }

  it('renders the policy exactly and warns about untrusted flow', () => {
    render(
      <RunPolicyCard
        automation={automationWith({ revision: 2, approved_revision: 1 })}
        policy={fixturePolicy}
        issues={[]}
        approving={false}
        onApprove={() => {}}
      />
    )

    expect(screen.getByText('cron "0 5 * * 1-5" in America/New_York')).toBeInTheDocument()
    expect(screen.getByText(formatDateTime(fixturePolicy.next_runs[2]))).toBeInTheDocument()
    expect(
      screen.getByText(/claude \(sonnet\) · times out after 2 min · no tools/)
    ).toBeInTheDocument()
    expect(screen.getByText('API_KEY')).toBeInTheDocument()
    expect(screen.getByText('hooks.example.com')).toBeInTheDocument()
    expect(screen.getByText('backoff 30s/1m/5m/15m/60m')).toBeInTheDocument()
    expect(screen.getByText(/Fetched pages can carry instructions/)).toBeInTheDocument()
  })

  it('disables approval while issues exist', () => {
    const onApprove = vi.fn()
    render(
      <RunPolicyCard
        automation={automationWith({ revision: 2, approved_revision: 1 })}
        policy={fixturePolicy}
        issues={[issue]}
        approving={false}
        onApprove={onApprove}
      />
    )

    const approve = screen.getByRole('button', { name: 'Approve and arm' })
    expect(approve).toBeDisabled()
    fireEvent.click(approve)
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('offers plain approval for a disabled automation, since approving does not arm it', () => {
    render(
      <RunPolicyCard
        automation={automationWith({ revision: 2, approved_revision: 1, enabled: false })}
        policy={fixturePolicy}
        issues={[]}
        approving={false}
        onApprove={() => {}}
      />
    )

    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Approve and arm' })).toBeNull()
  })

  it('hides approval once the revision on screen is approved', () => {
    render(
      <RunPolicyCard
        automation={fixtureAutomation}
        policy={fixturePolicy}
        issues={[]}
        approving={false}
        onApprove={() => {}}
      />
    )

    expect(screen.queryByRole('button', { name: 'Approve and arm' })).toBeNull()
  })
})

describe('AutomationDetail', () => {
  const props = {
    runs: [],
    narrow: false,
    isVisible: true,
    onOpenRun: () => {},
    onDeleted: () => {},
    onChanged: () => {}
  }

  it('approves the revision on screen', async () => {
    api.approveAutomation.mockResolvedValue(ok(undefined))
    render(
      <AutomationDetail {...props} detail={detailWith({ revision: 7, approved_revision: 6 })} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Approve and arm' }))

    await waitFor(() => expect(api.approveAutomation).toHaveBeenCalledWith('auto-1', 7))
  })

  it('lists validation issues by node label and blocks approval', () => {
    render(
      <AutomationDetail
        {...props}
        detail={detailWith({ revision: 2, approved_revision: 1 }, [
          {
            node_id: 'post' as NodeId,
            code: 'host_not_allowed',
            message: 'evil.com is not allowed'
          }
        ])}
      />
    )

    expect(screen.getByText('1 issue to fix before approval')).toBeInTheDocument()
    expect(screen.getByText('Notify:')).toBeInTheDocument()
    expect(screen.getByText('evil.com is not allowed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve and arm' })).toBeDisabled()
  })

  it('marks failures seen while the runs are on screen', () => {
    render(<AutomationDetail {...props} detail={detailWith({ unseen_failures: 2 })} />)

    expect(api.markAutomationSeen).toHaveBeenCalledWith('auto-1')
  })

  it('opens the new run after Run now', async () => {
    const onOpenRun = vi.fn()
    api.runAutomationNow.mockResolvedValue(ok(runWith({ id: 'run-9' as RunId })))
    render(<AutomationDetail {...props} onOpenRun={onOpenRun} detail={detailWith()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))

    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith('run-9'))
  })
})

describe('AutomationRunDetail', () => {
  it('lists every node in graph order with its step status, duration, output and error', async () => {
    api.getAutomationRunSteps.mockResolvedValue(ok(fixtureSteps))
    render(<AutomationRunDetail run={runWith()} onChanged={() => {}} />)

    const steps = within(screen.getByRole('list', { name: 'Steps' }))
    await waitFor(() => expect(steps.getByText('Succeeded')).toBeInTheDocument())
    const rows = steps.getAllByRole('listitem').map((row) => row.textContent)
    expect(rows).toEqual([
      'Fetch items800 msSucceededOutput',
      'ExtractNot reached',
      'Fetch failedSkipped',
      'Urgent?Not reached',
      'ShapeNot reached',
      'Notify1 sFailedsecret_missing:HOOK_KEY'
    ])

    fireEvent.click(steps.getByRole('button', { name: 'Output' }))
    expect(steps.getByText(/"title": "first"/)).toBeInTheDocument()
  })

  it('shows the steps of a running run even when a reply takes longer than the poll', async () => {
    vi.useFakeTimers()
    try {
      api.getAutomationRunSteps.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(ok(fixtureSteps)), 3000))
      )
      render(<AutomationRunDetail run={runWith({ status: 'running' })} onChanged={() => {}} />)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100)
      })

      const steps = within(screen.getByRole('list', { name: 'Steps' }))
      expect(steps.getByText('Succeeded')).toBeInTheDocument()
      expect(api.getAutomationRunSteps).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AutomationSecretsDialog', () => {
  it('saves a value through the facade and never renders it afterwards', async () => {
    api.listAutomationSecrets.mockResolvedValue(ok([]))
    api.setAutomationSecret.mockResolvedValue(ok(undefined))
    render(
      <AutomationSecretsDialog
        projectId="project-1"
        referenced={['API_KEY']}
        open
        onOpenChange={() => {}}
      />
    )

    await waitFor(() => expect(screen.getByText('Missing')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Set' }))
    const field = screen.getByLabelText('Value for API_KEY')
    expect(field).toHaveAttribute('type', 'password')
    fireEvent.change(field, { target: { value: 'sk-live-123' } })
    api.listAutomationSecrets.mockResolvedValue(ok(['API_KEY']))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(api.setAutomationSecret).toHaveBeenCalledWith('project-1', 'API_KEY', 'sk-live-123')
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
    expect(screen.queryByDisplayValue('sk-live-123')).toBeNull()
    expect(document.body.innerHTML).not.toContain('sk-live-123')
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument()
  })
})

describe('formatDateTime', () => {
  it('names the year only for a time outside the current year', () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 31, 12, 0), toFake: ['Date'] })
    try {
      expect(formatDateTime(new Date(2026, 10, 2, 9, 0).getTime())).toBe('Mon, Nov 2, 9:00 AM')
      expect(formatDateTime(new Date(2027, 0, 4, 9, 0).getTime())).toBe('Mon, Jan 4, 2027, 9:00 AM')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AutomationDiagram', () => {
  it('reads out every step and branch as a list while the drawing stays hidden', () => {
    render(
      <AutomationDiagram graph={fixtureAutomation.graph} trigger={fixtureAutomation.trigger} />
    )

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
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByTestId('automation-diagram').lastElementChild).toHaveAttribute(
      'aria-hidden',
      'true'
    )
  })
})

describe('approval runs', () => {
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
  const NOW = new Date(2026, 10, 3, 9, 0).getTime()
  const UNTIL = new Date(2026, 10, 3, 10, 0).getTime()
  const waitingRun = (): AutomationRun =>
    runWith({
      id: 'run-7' as RunId,
      graph,
      status: 'waiting',
      finished_at: null,
      stop_reason: null,
      parked: { node_id: GATE, until: UNTIL }
    })
  const waitingStep = {
    run_id: 'run-7' as RunId,
    node_id: GATE,
    status: 'waiting' as const,
    output: { message: 'Deploy manual?\nTwo files changed.' },
    error: null,
    started_at: NOW,
    finished_at: null
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    api.getAutomationRunSteps.mockResolvedValue(ok([waitingStep]))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the rendered message, the deadline and the decision buttons for a waiting run', async () => {
    render(<AutomationRunDetail run={waitingRun()} onChanged={() => {}} />)

    const card = within(await screen.findByRole('region', { name: 'Ship it?' }))
    await waitFor(() =>
      expect(card.getByText(/Deploy manual\?/)).toHaveTextContent(
        'Deploy manual? Two files changed.',
        { normalizeWhitespace: true }
      )
    )
    expect(card.getByText('Expires Tue, Nov 3, 10:00 AM')).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(card.getByRole('button', { name: 'Reject' })).toBeEnabled()
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Waiting for approval')
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeEnabled()
    const steps = within(screen.getByRole('list', { name: 'Steps' }))
    expect(steps.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'Ship it?Waiting for approvalOutput',
      'NotifyNot reached'
    ])
  })

  it('approves through the facade, holds the buttons while it is pending, then refreshes', async () => {
    let reply: (value: unknown) => void = () => {}
    api.decideAutomationApproval.mockReturnValue(
      new Promise((resolve) => {
        reply = resolve
      })
    )
    const onChanged = vi.fn()
    render(<AutomationRunDetail run={waitingRun()} onChanged={onChanged} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(api.decideAutomationApproval).toHaveBeenCalledWith('run-7', 'gate', true)
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled()
    await act(async () => reply(ok(true)))
    expect(onChanged).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(api.getAutomationRunSteps).toHaveBeenCalledTimes(2))
  })

  it('holds Approve until the message loads, but lets the run be rejected', async () => {
    api.getAutomationRunSteps.mockReturnValue(new Promise(() => {}))
    render(<AutomationRunDetail run={waitingRun()} onChanged={() => {}} />)

    const card = within(await screen.findByRole('region', { name: 'Ship it?' }))
    expect(card.getByText('Loading the message…')).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(card.getByRole('button', { name: 'Reject' })).toBeEnabled()
  })

  it('lets the reviewer act again after a decision whose refresh never lands', async () => {
    api.decideAutomationApproval.mockResolvedValue(ok(true))
    render(<AutomationRunDetail run={waitingRun()} onChanged={() => {}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    })

    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled()
  })

  it('rejects, and treats an already-decided reply as a refresh, not an error', async () => {
    api.decideAutomationApproval.mockResolvedValue(ok(false))
    const onChanged = vi.fn()
    render(<AutomationRunDetail run={waitingRun()} onChanged={onChanged} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    })

    expect(api.decideAutomationApproval).toHaveBeenCalledWith('run-7', 'gate', false)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('re-enables the buttons and reports a failed decision', async () => {
    api.decideAutomationApproval.mockResolvedValue({
      success: false,
      error: 'host offline',
      code: 'NETWORK'
    })
    const onChanged = vi.fn()
    render(<AutomationRunDetail run={waitingRun()} onChanged={onChanged} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled())

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    })

    expect(toast.error).toHaveBeenCalledWith('Could not record the decision: host offline')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('shows no decision card once the run has moved on, and the decision on its step', async () => {
    api.getAutomationRunSteps.mockResolvedValue(
      ok([
        {
          ...waitingStep,
          status: 'failed',
          output: { ...waitingStep.output, decision: 'rejected', decided_at: UNTIL },
          error: 'rejected',
          finished_at: UNTIL
        }
      ])
    )
    const settled: AutomationRun = {
      ...waitingRun(),
      status: 'failed',
      finished_at: UNTIL,
      parked: null
    }
    render(<AutomationRunDetail run={settled} onChanged={() => {}} />)

    const steps = within(screen.getByRole('list', { name: 'Steps' }))
    await waitFor(() => expect(steps.getByText('Rejected')).toHaveClass('text-destructive'))
    expect(steps.getAllByRole('listitem')[0]).toHaveTextContent(
      'Ship it?1 hFailedRejected · Tue, Nov 3, 10:00 AMOutput'
    )
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Ship it?' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull()
  })

  it('points the automation at its waiting run, and lists it as waiting', () => {
    const onOpenRun = vi.fn()
    render(
      <AutomationDetail
        detail={detailWith()}
        runs={[waitingRun(), runWith()]}
        narrow={false}
        isVisible
        onOpenRun={onOpenRun}
        onDeleted={() => {}}
        onChanged={() => {}}
      />
    )

    expect(screen.getByText('A run is waiting for your approval.')).toBeInTheDocument()
    expect(screen.getByText('Waiting for approval')).toHaveClass('text-warning')
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onOpenRun).toHaveBeenCalledWith('run-7')
  })

  it('shows no waiting banner when no run is waiting', () => {
    render(
      <AutomationDetail
        detail={detailWith()}
        runs={[runWith()]}
        narrow={false}
        isVisible
        onOpenRun={() => {}}
        onDeleted={() => {}}
        onChanged={() => {}}
      />
    )

    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.queryByText('A run is waiting for your approval.')).toBeNull()
  })

  it('draws an approval node with its message as the key detail', () => {
    render(<AutomationDiagram graph={graph} trigger={{ kind: 'manual' }} />)

    const steps = within(screen.getByRole('list', { name: 'Automation steps' }))
    expect(steps.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Trigger: Run manually. Next: Ship it?',
      'Ship it?, Approval: Deploy {{trigger.kind}}?. Next: Notify',
      'Notify, Transform: text'
    ])
  })
})
