import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as appSettingsHooks from '@/hooks/use-app-settings'
import { useGitStatusStore } from '@/stores/git-status-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import type { Project } from '@/types/project'
import { ShellToolStrip } from './ShellToolStrip'

const { tauriRef, macRef, mockLog, refreshWorkingCopy } = vi.hoisted(() => ({
  tauriRef: { current: true },
  macRef: { current: false },
  mockLog: vi.fn(() => Promise.resolve()),
  refreshWorkingCopy: vi.fn(() => Promise.resolve())
}))

vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauriContext: () => tauriRef.current
}))
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get isMac() {
    return macRef.current
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLog }))
vi.mock('@/components/RemoteAccessPopover', () => ({
  RemoteAccessPopover: () => <button type="button">Remote terminal access</button>
}))
vi.mock('@/components/ConnectionStatusIndicator', () => ({
  ConnectionStatusIndicator: () => <span role="status" aria-label="Connected" />
}))

const updatePanelVisibility = vi.fn((panel: string, visible: boolean) => {
  if (panel === 'fileExplorerVisible') useShellLayoutStore.setState({ sidePanelVisible: visible })
  return Promise.resolve()
})

const project = { id: 'p1', name: 'One', path: '/repo', isGitRepo: true } as Project

function renderStrip(overrides: Partial<React.ComponentProps<typeof ShellToolStrip>> = {}): {
  onNewTerminal: ReturnType<typeof vi.fn>
  onNewBrowserTab: ReturnType<typeof vi.fn>
} {
  const onNewTerminal = vi.fn()
  const onNewBrowserTab = vi.fn()
  render(
    <ShellToolStrip
      activeProject={project}
      sshOpen={false}
      onNewTerminal={onNewTerminal}
      onNewBrowserTab={onNewBrowserTab}
      {...overrides}
    />
  )
  return { onNewTerminal, onNewBrowserTab }
}

const strip = () => screen.getByRole('toolbar', { name: 'Tools' })
const button = (name: string) => within(strip()).getByRole('button', { name })
const layout = () => useShellLayoutStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  tauriRef.current = true
  macRef.current = false
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'ready' })
  useGitStatusStore.setState({ statuses: {}, refreshWorkingCopy } as never)
  vi.spyOn(appSettingsHooks, 'useUpdatePanelVisibility').mockReturnValue(updatePanelVisibility)
})

describe('ShellToolStrip', () => {
  it('starts below the window controls on Windows/Linux desktop only', () => {
    renderStrip()
    expect(strip()).toHaveClass('pt-[50px]')
    cleanup()

    macRef.current = true
    renderStrip()
    expect(strip()).not.toHaveClass('pt-[50px]')
    cleanup()

    macRef.current = false
    tauriRef.current = false
    renderStrip()
    expect(strip()).not.toHaveClass('pt-[50px]')
  })

  it('shows Explorer, Changes, GitHub on top and Terminal, Browser, Remote access pinned', () => {
    renderStrip()
    const [top, bottom] = within(strip()).getAllByRole('group')
    expect(
      within(top)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'))
    ).toEqual(['Explorer', 'Changes', 'GitHub'])
    expect(
      within(bottom)
        .getAllByRole('button')
        .map((b) => b.textContent || b.getAttribute('aria-label'))
    ).toEqual(['New terminal', 'New browser tab', 'Remote terminal access'])
  })

  it('opens the right panel on a view and raises its button; the same click closes it', () => {
    renderStrip()
    expect(button('Changes')).not.toHaveClass('keycap')

    fireEvent.click(button('Changes'))
    expect(updatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', true)
    expect(layout().lastColumnTabByProject).toEqual({ p1: 'changes' })
    expect(button('Changes')).toHaveClass('keycap')
    expect(button('Changes')).toHaveAttribute('aria-pressed', 'true')
    expect(button('Explorer')).not.toHaveClass('keycap')

    fireEvent.click(button('Changes'))
    expect(updatePanelVisibility).toHaveBeenLastCalledWith('fileExplorerVisible', false)
    expect(button('Changes')).not.toHaveClass('keycap')
  })

  it('switches views while the panel stays open', () => {
    useShellLayoutStore.setState({ sidePanelVisible: true })
    renderStrip()
    // Explorer is the default view.
    expect(button('Explorer')).toHaveClass('keycap')
    fireEvent.click(button('GitHub'))
    expect(layout().lastColumnTabByProject).toEqual({ p1: 'github' })
    expect(layout().sidePanelVisible).toBe(true)
    expect(updatePanelVisibility).not.toHaveBeenCalled()
    expect(button('GitHub')).toHaveClass('keycap')
  })

  it('logs the panel toggle under the Shell source', () => {
    renderStrip()
    fireEvent.click(button('Explorer'))
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        source: 'Shell',
        message: '[shell] right panel shows explorer via strip'
      })
    )
  })

  it('shows the changed-file count as a blue badge on Changes', () => {
    useGitStatusStore.setState({
      statuses: {
        '/repo': [
          { path: 'a.ts', status: 'modified', staged: false },
          { path: 'b.ts', status: 'untracked', staged: false }
        ]
      }
    } as never)
    renderStrip()
    const badge = within(button('Changes')).getByTestId('tool-strip-changes-badge')
    expect(badge).toHaveTextContent('2')
    expect(badge).toHaveClass('bg-primary-fill', 'absolute', 'h-4', 'min-w-4')
  })

  it('tracks the working copy so the count loads while the panel is hidden', () => {
    renderStrip()
    expect(refreshWorkingCopy).toHaveBeenCalledWith('/repo')
  })

  it('opens a new terminal and a new browser tab on every click, and logs each', () => {
    const { onNewTerminal, onNewBrowserTab } = renderStrip()
    fireEvent.click(button('New terminal'))
    fireEvent.click(button('New terminal'))
    fireEvent.click(button('New browser tab'))
    fireEvent.click(button('New browser tab'))
    expect(onNewTerminal).toHaveBeenCalledTimes(2)
    expect(onNewBrowserTab).toHaveBeenCalledTimes(2)
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'Shell', message: '[shell] strip opens a terminal tab' })
    )
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'Shell', message: '[shell] strip opens a browser tab' })
    )
  })

  it('on web: no Browser and no Remote access, the connection lamp instead', () => {
    tauriRef.current = false
    renderStrip()
    expect(within(strip()).queryByRole('button', { name: 'New browser tab' })).toBeNull()
    expect(within(strip()).queryByText('Remote terminal access')).toBeNull()
    expect(within(strip()).getByRole('status', { name: 'Connected' })).toBeInTheDocument()
  })

  it('in SSH mode: Explorer toggles the panel, the git views and new tabs are off', () => {
    renderStrip({ sshOpen: true })
    for (const name of ['Changes', 'GitHub', 'New terminal', 'New browser tab']) {
      expect(button(name)).toBeDisabled()
    }
    fireEvent.click(button('Explorer'))
    expect(updatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', true)
    expect(layout().lastColumnTabByProject).toEqual({})
    expect(button('Explorer')).toHaveClass('keycap')
  })

  it('disables every view and new tab without a project folder', () => {
    renderStrip({ activeProject: undefined })
    for (const name of ['Explorer', 'Changes', 'GitHub', 'New terminal', 'New browser tab']) {
      expect(button(name)).toBeDisabled()
    }
  })
})
