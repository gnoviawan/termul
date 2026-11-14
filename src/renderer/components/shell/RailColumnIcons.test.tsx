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
  // The Rail shows these icons only while the Side panel is off screen.
  useShellLayoutStore.setState({ sidePanelVisible: false })
  useGitStatusStore.setState({ statuses: {} })
  useSSHStore.setState({ workspaceOpen: false })
  vi.spyOn(appSettingsHooks, 'useUpdatePanelVisibility').mockReturnValue(updatePanelVisibility)
})

describe('RailColumnIcons', () => {
  it('renders Chats, Explorer, Changes and GitHub in order, none pressed', () => {
    renderIcons()
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Chats',
      'Explorer',
      'Changes',
      'GitHub'
    ])
    for (const b of buttons) expect(b).not.toHaveAttribute('aria-pressed')
  })

  it('selects the tab through the shell-layout store', () => {
    renderIcons()
    fireEvent.click(button('Explorer'))
    expect(useShellLayoutStore.getState().lastColumnTabByProject.p1).toBe('explorer')

    fireEvent.click(button('Changes'))
    expect(useShellLayoutStore.getState().lastColumnTabByProject.p1).toBe('changes')

    fireEvent.click(button('GitHub'))
    expect(useShellLayoutStore.getState().lastColumnTabByProject.p1).toBe('github')
  })

  it('expands the Rail from Chats (chats list in the Rail) and writes no tab', () => {
    renderIcons()
    fireEvent.click(button('Chats'))
    expect(updatePanelVisibility).toHaveBeenCalledWith('sidebarVisible', true)
    expect(updatePanelVisibility).not.toHaveBeenCalledWith('fileExplorerVisible', true)
    expect(useShellLayoutStore.getState().lastColumnTabByProject.p1).toBeUndefined()
  })

  it('shows a hidden Side panel through the persisted path, selecting the tab', () => {
    renderIcons()
    fireEvent.click(button('Explorer'))
    expect(useShellLayoutStore.getState().lastColumnTabByProject.p1).toBe('explorer')
    expect(updatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', true)
  })

  it('moves focus to the Side panel tab once the panel mounts', async () => {
    renderIcons()
    const panelTab = document.createElement('button')
    panelTab.id = 'side-panel-tab-changes'
    button('Changes').focus()
    fireEvent.click(button('Changes'))
    document.body.append(panelTab)
    await waitFor(() => expect(panelTab).toHaveFocus())
    panelTab.remove()
  })

  it('toasts when showing the panel fails', async () => {
    updatePanelVisibility.mockRejectedValueOnce(new Error('disk full'))
    renderIcons()
    fireEvent.click(button('Chats'))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('disk full'))
  })

  it('never writes the tab while the SSH workspace is open, but still shows the column', () => {
    useSSHStore.setState({ workspaceOpen: true })
    renderIcons()
    fireEvent.click(button('Changes'))
    expect(useShellLayoutStore.getState().lastColumnTabByProject.p1).toBeUndefined()
    expect(updatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', true)
  })

  it('is disabled without a project', () => {
    renderIcons(null as unknown as undefined)
    for (const name of ['Chats', 'Explorer', 'Changes', 'GitHub']) {
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
