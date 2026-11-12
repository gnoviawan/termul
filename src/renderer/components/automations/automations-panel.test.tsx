import type { Automation, AutomationId } from '@shared/types/automation.types'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { automationWith, detailWith } from '@/lib/test-utils/automation-fixtures'

const phone = vi.hoisted(() => ({ current: false }))
const hosted = vi.hoisted(() => ({ automations: [] as Automation[] }))
const writes = vi.hoisted(() => ({ admitted: true }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => writes.admitted
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => phone.current }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))
vi.mock('@/lib/automation-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/automation-api')>()
  const ok = <T,>(data: T) => Promise.resolve({ success: true as const, data })
  return {
    ...actual,
    listAutomations: vi.fn(() => ok(hosted.automations)),
    getAutomation: vi.fn((id: AutomationId) => {
      const automation = hosted.automations.find((candidate) => candidate.id === id)
      return automation
        ? ok(detailWith(automation))
        : Promise.resolve({ success: false as const, error: 'automation not found' })
    }),
    listAutomationRuns: vi.fn(() => ok([])),
    previewAutomationOps: vi.fn((id: AutomationId) => {
      const automation = hosted.automations.find((candidate) => candidate.id === id) ?? first
      return ok(detailWith(automation))
    }),
    markAutomationSeen: vi.fn(() => ok(undefined))
  }
})

import { publishAutomationChange } from '@/lib/automation-api'
import { expectWriteGated } from '@/lib/test-utils/write-gate'
import { READ_ONLY_SERVER_REASON } from '@/lib/write-gate'
import { AutomationsPanel } from './AutomationsPanel'
import { useAutomationFocus } from './automation-focus'

const first = automationWith({ id: 'auto-1' as AutomationId, name: 'Morning digest' })
const second = automationWith({ id: 'auto-2' as AutomationId, name: 'Open PR summary' })

function deleteSecondElsewhere(): void {
  hosted.automations = [first]
  act(() => publishAutomationChange({ project_id: 'p1', automation_id: 'auto-2' }))
}

beforeEach(() => {
  phone.current = false
  writes.admitted = true
  hosted.automations = [first, second]
})

describe('AutomationsPanel', () => {
  it('falls back to the first automation when the chosen one is deleted elsewhere', async () => {
    render(<AutomationsPanel projectId="p1" isVisible />)
    fireEvent.click(await screen.findByRole('button', { name: /Open PR summary/ }))
    expect(await screen.findByRole('heading', { name: 'Open PR summary' })).toBeInTheDocument()

    deleteSecondElsewhere()

    expect(await screen.findByRole('heading', { name: 'Morning digest' })).toBeInTheDocument()
    expect(screen.queryByText(/Could not load it/)).toBeNull()
  })

  it('on the phone, returns to the list when the open automation is deleted elsewhere', async () => {
    phone.current = true
    render(<AutomationsPanel projectId="p1" isVisible />)
    fireEvent.click(await screen.findByRole('button', { name: /Open PR summary/ }))
    expect(await screen.findByRole('heading', { name: 'Open PR summary' })).toBeInTheDocument()

    deleteSecondElsewhere()

    expect(await screen.findByRole('button', { name: /Morning digest/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Open PR summary' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Automations' })).toBeNull()
  })

  it.each([
    ['desktop', false],
    ['phone', true]
  ])('on a read-only remote client (%s), the open automation offers no write that would fail', async (_, onPhone) => {
    phone.current = onPhone
    writes.admitted = false
    render(<AutomationsPanel projectId="p1" isVisible />)
    fireEvent.click(await screen.findByRole('button', { name: /Open PR summary/ }))
    expect(await screen.findByRole('heading', { name: 'Open PR summary' })).toBeInTheDocument()

    expectWriteGated(screen.getByRole('button', { name: 'Run now' }))
    expectWriteGated(screen.getByRole('switch', { name: 'Enabled' }))
    expect(screen.getByText(READ_ONLY_SERVER_REASON, { selector: 'p' })).toBeInTheDocument()
  })

  /** Opens the editor on the first automation and deletes a step, so the draft has an edit. */
  async function editWithAnUnsavedChange(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const editor = await screen.findByTestId('automation-editor')
    const fetchCard = editor.querySelector('.react-flow__node[data-id="fetch"]') as HTMLElement
    fireEvent.click(within(fetchCard).getByText('Fetch items'))
    fireEvent.keyDown(fetchCard, { key: 'Delete' })
    expect(screen.getByTestId('draft-status')).toHaveTextContent('Draft · 1 unsaved change')
  }

  it('asks before another automation takes the pane from an editor with edits', async () => {
    render(<AutomationsPanel projectId="p1" isVisible />)
    await editWithAnUnsavedChange()

    act(() => useAutomationFocus.getState().request('p1', second.id))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm).toHaveTextContent('discard 1 unsaved change')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    // Kept: the editor and its edit are still here.
    expect(screen.getByTestId('draft-status')).toHaveTextContent('Draft · 1 unsaved change')
    expect(screen.queryByRole('heading', { name: 'Open PR summary' })).toBeNull()

    act(() => useAutomationFocus.getState().request('p1', second.id))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' })
    )
    expect(await screen.findByRole('heading', { name: 'Open PR summary' })).toBeInTheDocument()
    expect(screen.queryByTestId('automation-editor')).toBeNull()
  })

  it('leaves a clean editor for a focus request, and does not reopen it on reselect', async () => {
    render(<AutomationsPanel projectId="p1" isVisible />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(await screen.findByTestId('automation-editor')).toBeInTheDocument()

    act(() => useAutomationFocus.getState().request('p1', second.id))
    expect(await screen.findByRole('heading', { name: 'Open PR summary' })).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Morning digest/ }))
    expect(await screen.findByRole('heading', { name: 'Morning digest' })).toBeInTheDocument()
    expect(screen.queryByTestId('automation-editor')).toBeNull()
  })
})
