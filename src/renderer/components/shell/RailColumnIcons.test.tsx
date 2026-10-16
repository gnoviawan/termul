import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import * as appSettingsHooks from '@/hooks/use-app-settings'
import { useGitStatusStore } from '@/stores/git-status-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { useSSHStore } from '@/stores/ssh-store'
import type { Project } from '@/types/project'
import { RailColumnIcons } from './RailColumnIcons'

const { mockToastError, running } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  running: { ids: new Set<string>() }
}))

vi.mock('sonner', () => ({ toast: { error: mockToastError } }))
vi.mock('@/hooks/use-agent-chat-attention', () => ({
  useAgentChatProjectSignals: () => ({
    attentionCounts: {},
    firstNeedsYouSessionId: {},
    runningProjectIds: running.ids
  })
}))

const project = {
  id: 'p1',
  name: 'Alpha',
  color: 'blue',
  path: '/repo/alpha',
  isGitRepo: true
} as Project

const updatePanelVisibility = vi.fn((panel: string, visible: boolean) => {
  if (panel === 'fileExplorerVisible') useShellLayoutStore.setState({ sidePanelVisible: visible })
  return Promise.resolve()
})

function renderIcons(activeProject: Project | undefined = project) {
  return render(
    <TooltipProvider>
      <RailColumnIcons activeProject={activeProject} />
    </TooltipProvider>
  )
}

const button = (name: string): HTMLElement => screen.getByRole('button', { name })

beforeEach(() => {
  vi.clearAllMocks()
  running.ids = new Set()
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'unavailable' })
  useGitStatusStore.setState({ statuses: {} })
  useSSHStore.setState({ workspaceOpen: false })
  vi.spyOn(appSettingsHooks, 'useUpdatePanelVisibility').mockReturnValue(updatePanelVisibility)
})

describe('RailColumnIcons', () => {
  it('renders Chats, Explorer and Changes in order with Chats selected by default', () => {
    renderIcons()
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Chats',
      'Explorer',
      'Changes'
    ])
    expect(button('Chats')).toHaveAttribute('aria-pressed', 'true')
    expect(button('Explorer')).toHaveAttribute('aria-pressed', 'false')
    expect(button('Changes')).toHaveAttribute('aria-pressed', 'false')
  })

  it('selects the tab through the shell-layout store and moves the pressed state', () => {
    renderIcons()
    fireEvent.click(button('Explorer'))
    expect(useShellLayoutStore.getState().lastColumnTabByProject.p1).toBe('explorer')
    expect(button('Explorer')).toHaveAttribute('aria-pressed', 'true')
    expect(button('Chats')).toHaveAttribute('aria-pressed', 'false')
    expect(updatePanelVisibility).not.toHaveBeenCalled()

    fireEvent.click(button('Changes'))
    expect(useShellLayoutStore.getState().lastColumnTabByProject.p1).toBe('changes')
  })

  it('reflects the project last tab', () => {
    useShellLayoutStore.getState().setLastColumnTab('p1', 'changes')
    renderIcons()
    expect(button('Changes')).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows a hidden Side panel through the persisted path, selecting the tab', () => {
    useShellLayoutStore.setState({ sidePanelVisible: false })
    renderIcons()
    // Nothing is selected while the panel is hidden.
    expect(button('Chats')).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(button('Explorer'))
    expect(useShellLayoutStore.getState().lastColumnTabByProject.p1).toBe('explorer')
    expect(updatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', true)
  })

  it('toasts when showing the panel fails', async () => {
    useShellLayoutStore.setState({ sidePanelVisible: false })
    updatePanelVisibility.mockRejectedValueOnce(new Error('disk full'))
    renderIcons()
    fireEvent.click(button('Chats'))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('disk full'))
  })

  it('never writes the tab while the SSH workspace is open, but still shows the column', () => {
    useSSHStore.setState({ workspaceOpen: true })
    useShellLayoutStore.setState({ sidePanelVisible: false })
    renderIcons()
    fireEvent.click(button('Changes'))
    expect(useShellLayoutStore.getState().lastColumnTabByProject.p1).toBeUndefined()
    expect(updatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', true)
    expect(button('Chats')).toHaveAttribute('aria-pressed', 'false')
  })

  it('is disabled without a project', () => {
    renderIcons(null as unknown as undefined)
    for (const name of ['Chats', 'Explorer', 'Changes']) {
      expect(button(name)).toBeDisabled()
    }
    fireEvent.click(button('Explorer'))
    expect(updatePanelVisibility).not.toHaveBeenCalled()
  })

  it('shows no live dot on Chats while nothing is running', () => {
    renderIcons()
    expect(screen.queryByTestId('rail-chats-live-dot')).toBeNull()
  })

  it('shows the live dot when the project is running', () => {
    running.ids = new Set(['p1'])
    renderIcons()
    expect(button('Chats')).toContainElement(screen.getByTestId('rail-chats-live-dot'))
  })

  it('shows the changed-file count on Changes above 0, capped at 99', () => {
    const status = (path: string) => ({ path }) as never
    useGitStatusStore.setState({ statuses: { '/repo/alpha': [status('a'), status('b')] } })
    renderIcons()
    expect(screen.getByTestId('rail-changes-badge')).toHaveTextContent('2')
  })

  it('caps the badge at 99+', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ path: `f${i}` }) as never)
    useGitStatusStore.setState({ statuses: { '/repo/alpha': many } })
    renderIcons()
    expect(screen.getByTestId('rail-changes-badge')).toHaveTextContent('99+')
  })

  it('shows no badge at 0', () => {
    renderIcons()
    expect(screen.queryByTestId('rail-changes-badge')).toBeNull()
  })
})
