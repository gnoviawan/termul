import type { AutomationId, Issue, NodeId, RunId } from '@shared/types/automation.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

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
