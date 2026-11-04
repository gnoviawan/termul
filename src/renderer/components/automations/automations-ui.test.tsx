import wire from '@shared/types/__fixtures__/automation.json'
import type {
  AutomationId,
  AutomationStep,
  AutomationSuggestion,
  Graph,
  Issue,
  NodeId,
  RunId
} from '@shared/types/automation.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSuggestionList } from '@/lib/automation-wire'
import {
  automationWith,
  detailWith,
  fixtureAutomation,
  fixturePolicy,
  fixtureSteps,
  runWith
} from '@/lib/test-utils/automation-fixtures'
import { expectNotWriteGated, expectWriteGated } from '@/lib/test-utils/write-gate'
import { READ_ONLY_SERVER_REASON } from '@/lib/write-gate'

const api = vi.hoisted(() => ({
  approveAutomation: vi.fn(),
  cancelAutomationRun: vi.fn(),
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
const writes = vi.hoisted(() => ({ admitted: true }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => writes.admitted
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { AutomationDetail } from './AutomationDetail'
import { AutomationDiagram } from './AutomationDiagram'
import { AutomationList, EMPTY_EXAMPLE } from './AutomationList'
import { AutomationRunDetail } from './AutomationRunDetail'
import { AutomationSecretsDialog } from './AutomationSecretsDialog'
import { AutomationSuggestionCard } from './AutomationSuggestionCard'
import { formatDateTime } from './automation-format'
import { RunPolicyCard } from './RunPolicyCard'

const ok = <T,>(data: T) => ({ success: true as const, data })
const [SUGGESTION] = parseSuggestionList([wire.suggestion]) as [AutomationSuggestion]

beforeEach(() => {
  vi.clearAllMocks()
  writes.admitted = true
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
      screen.getByText(/claude \(sonnet\) · times out after 2 min · tools: read files, search$/)
    ).toBeInTheDocument()
    expect(screen.getByText('API_KEY')).toBeInTheDocument()
    expect(screen.getByText('hooks.example.com')).toBeInTheDocument()
    expect(screen.getByText('backoff 30s/1m/5m/15m/60m')).toBeInTheDocument()
    expect(screen.getByText(/Fetched pages can carry instructions/)).toBeInTheDocument()
  })

  it('says when an agent gets no tools', () => {
    render(
      <RunPolicyCard
        automation={automationWith({ revision: 2, approved_revision: 1 })}
        policy={{ ...fixturePolicy, agents: [{ ...fixturePolicy.agents[0], tools: [] }] }}
        issues={[]}
        approving={false}
        onApprove={() => {}}
      />
    )

    expect(
      screen.getByText(/claude \(sonnet\) · times out after 2 min · no tools$/)
    ).toBeInTheDocument()
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
    render(<AutomationRunDetail run={runWith()} />)

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
      render(<AutomationRunDetail run={runWith({ status: 'running' })} />)

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

describe('AutomationRunDetail with a loop and a wait', () => {
  const graph: Graph = {
    nodes: [
      {
        id: 'each' as NodeId,
        label: 'Each item',
        spec: { kind: 'for_each', items: '{{trigger.kind}}', max_iterations: 5 }
      },
      { id: 'send' as NodeId, label: 'Send', spec: { kind: 'transform', fields: [] } },
      { id: 'pause' as NodeId, label: 'Pause', spec: { kind: 'wait', duration_ms: 60_000 } },
      { id: 'done' as NodeId, label: 'Done', spec: { kind: 'transform', fields: [] } }
    ],
    edges: [
      { from: 'trigger', port: 'out', to: 'each' as NodeId },
      { from: 'each' as NodeId, port: 'out', to: 'done' as NodeId },
      { from: 'each' as NodeId, port: 'item', to: 'send' as NodeId },
      { from: 'send' as NodeId, port: 'out', to: 'pause' as NodeId }
    ]
  }
  const run = runWith({ status: 'running', graph })
  const WAIT_UNTIL = 1_773_050_461_000
  const step = (
    node: string,
    iteration: number | null,
    status: AutomationStep['status'],
    extra: Partial<AutomationStep> = {}
  ): AutomationStep => ({
    run_id: run.id,
    node_id: node as NodeId,
    iteration,
    status,
    output: null,
    error: null,
    started_at: 1_000,
    finished_at: status === 'running' || status === 'waiting' ? null : 1_500,
    wait_until: null,
    ...extra
  })

  it('groups a body node by iteration and says when a parked wait resumes', async () => {
    api.getAutomationRunSteps.mockResolvedValue(
      ok([
        step('each', null, 'running'),
        step('send', 0, 'succeeded', { output: { n: 0 } }),
        step('pause', 0, 'succeeded'),
        step('send', 1, 'succeeded', { output: { n: 1 } }),
        step('pause', 1, 'waiting', { wait_until: WAIT_UNTIL })
      ])
    )
    render(<AutomationRunDetail run={run} />)

    const steps = within(screen.getByRole('list', { name: 'Steps' }))
    await waitFor(() => expect(steps.getByText('Running')).toBeInTheDocument())
    const waiting = `Waiting until ${formatDateTime(WAIT_UNTIL)}`
    expect(steps.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'Each itemRunning',
      'Send2 iterationsSucceededIterations',
      'DoneNot reached',
      'Pause2 iterationsWaitingIterations'
    ])

    fireEvent.click(
      within(steps.getAllByRole('listitem')[3]).getByRole('button', { name: 'Iterations' })
    )
    const pauses = within(screen.getByRole('list', { name: 'Pause iterations' }))
    expect(pauses.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'Item 1500 msSucceeded',
      `Item 2Waiting${waiting}`
    ])
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

describe('write controls on a server that refuses remote writes', () => {
  const SURFACES = [
    ['a read-only remote client', false],
    ['the desktop', true]
  ] as const
  const expectGate = (el: HTMLElement, admitted: boolean): void =>
    admitted ? expectNotWriteGated(el) : expectWriteGated(el)
  const hint = (): HTMLElement | null =>
    screen.queryByText(READ_ONLY_SERVER_REASON, { selector: 'p' })
  const detailProps = {
    runs: [],
    narrow: false,
    isVisible: true,
    onOpenRun: () => {},
    onDeleted: () => {},
    onChanged: () => {}
  }

  it.each(SURFACES)('AutomationDetail on %s', (_, admitted) => {
    writes.admitted = admitted
    render(
      <AutomationDetail
        {...detailProps}
        detail={detailWith({ revision: 7, approved_revision: 6, unseen_failures: 2 })}
      />
    )

    for (const name of ['Approve and arm', 'Run now', 'Delete']) {
      expectGate(screen.getByRole('button', { name }), admitted)
    }
    expectGate(screen.getByRole('switch', { name: 'Enabled' }), admitted)
    expectNotWriteGated(screen.getByRole('button', { name: 'Secrets' }))
    expect(hint() !== null).toBe(!admitted)
    expect(api.markAutomationSeen.mock.calls).toEqual(admitted ? [['auto-1']] : [])
  })

  it.each(SURFACES)('AutomationRunDetail on %s', (_, admitted) => {
    writes.admitted = admitted
    api.getAutomationRunSteps.mockReturnValue(new Promise(() => {}))
    render(<AutomationRunDetail run={runWith({ status: 'running' })} />)

    const cancel = screen.getByRole('button', { name: 'Cancel run' })
    expectGate(cancel, admitted)
    expect(hint() !== null).toBe(!admitted)
  })

  it.each(SURFACES)('AutomationSecretsDialog on %s', async (_, admitted) => {
    writes.admitted = admitted
    api.listAutomationSecrets.mockResolvedValue(ok(['API_KEY']))
    render(
      <AutomationSecretsDialog
        projectId="project-1"
        referenced={['API_KEY', 'HOOK_KEY']}
        open
        onOpenChange={() => {}}
      />
    )

    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument())
    expect(screen.getByText('Missing')).toBeInTheDocument()
    for (const name of ['Replace', 'Delete', 'Set']) {
      expectGate(screen.getByRole('button', { name }), admitted)
    }
    expect(hint() !== null).toBe(!admitted)
  })

  it.each(SURFACES)('AutomationSuggestionCard on %s keeps Not now', (_, admitted) => {
    writes.admitted = admitted
    const onLater = vi.fn()
    render(
      <AutomationSuggestionCard
        suggestion={SUGGESTION}
        busy={false}
        onCreate={() => {}}
        onLater={onLater}
        onDismiss={() => {}}
      />
    )

    expectGate(screen.getByRole('button', { name: 'Create automation' }), admitted)
    expectGate(screen.getByRole('button', { name: "Don't suggest this again" }), admitted)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(onLater).toHaveBeenCalledTimes(1)
    expect(hint() !== null).toBe(!admitted)
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
