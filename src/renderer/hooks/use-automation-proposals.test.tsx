import type { AutomationId } from '@shared/types/automation.types'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { automationWith, detailWith } from '@/lib/test-utils/automation-fixtures'

const phone = vi.hoisted(() => ({ current: false }))
const toast = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: Object.assign(toast, { error: vi.fn() }) }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => phone.current }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))
vi.mock('@/lib/automation-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/automation-api')>()
  const ok = <T,>(data: T) => Promise.resolve({ success: true as const, data })
  const first = automationWith({ id: 'auto-1' as AutomationId, name: 'Morning digest' })
  const second = automationWith({ id: 'auto-2' as AutomationId, name: 'Open PR summary' })
  return {
    ...actual,
    listAutomations: vi.fn(() => ok([first, second])),
    getAutomation: vi.fn((id: AutomationId) =>
      ok(detailWith(id === 'auto-2' ? second : first))
    ),
    listAutomationRuns: vi.fn(() => ok([])),
    markAutomationSeen: vi.fn(() => ok(undefined))
  }
})

import { AutomationsPanel } from '@/components/automations/AutomationsPanel'
import { publishAutomationChange } from '@/lib/automation-api'
import { createProjectWorkspace, findPaneById, useWorkspaceStore } from '@/stores/workspace-store'
import { useAutomationProposals } from './use-automation-proposals'

function activeTabId(): string | null {
  const { root, activePaneId } = useWorkspaceStore.getState()
  const pane = findPaneById(root, activePaneId)
  return pane?.type === 'leaf' ? pane.activeTabId : null
}

function Harness(): React.JSX.Element {
  useAutomationProposals()
  return <AutomationsPanel projectId="p1" isVisible />
}

const proposal = {
  project_id: 'p1',
  automation_id: 'auto-2',
  proposed: true,
  proposed_by: 'Claude'
}

beforeEach(() => {
  phone.current = false
  toast.mockClear()
  useWorkspaceStore.setState({ activeProjectId: '', parkedTrees: {} })
  useWorkspaceStore.getState().activateProject('p1', createProjectWorkspace())
})

describe('useAutomationProposals', () => {
  it('opens the proposed automation in the Automations tab of the project on screen', async () => {
    render(<Harness />)
    expect(await screen.findByRole('heading', { name: 'Morning digest' })).toBeInTheDocument()

    act(() => publishAutomationChange(proposal))

    expect(await screen.findByRole('heading', { name: 'Open PR summary' })).toBeInTheDocument()
    expect(activeTabId()).toBe('automations-p1')
    expect(toast).toHaveBeenCalledWith('Claude proposed an automation — review and approve')
  })

  it('on the phone, goes from the list straight to the proposed automation', async () => {
    phone.current = true
    render(<Harness />)
    expect(await screen.findByText('Morning digest')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Automations' })).toBeNull()

    act(() => publishAutomationChange({ ...proposal, proposed_by: undefined }))

    expect(await screen.findByRole('heading', { name: 'Open PR summary' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Automations' })).toBeInTheDocument()
    expect(toast).toHaveBeenCalledWith('An agent proposed an automation — review and approve')
  })

  it('leaves a proposal for another project, and plain changes, alone', async () => {
    render(<Harness />)
    expect(await screen.findByRole('heading', { name: 'Morning digest' })).toBeInTheDocument()

    act(() => {
      publishAutomationChange({ ...proposal, project_id: 'p2' })
      publishAutomationChange({ project_id: 'p1', automation_id: 'auto-2' })
    })

    expect(screen.getByRole('heading', { name: 'Morning digest' })).toBeInTheDocument()
    expect(activeTabId()).toBe(null)
    expect(toast).toHaveBeenCalledTimes(0)
  })
})
