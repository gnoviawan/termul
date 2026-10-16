import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetNativeWebviewOcclusionForTests,
  useNativeWebviewOccluded
} from '@/hooks/use-native-webview-occlusion'
import { OUTSIDE_PROJECT_ROOT_REASON } from '@/lib/active-worktree'
import { mockAcpSession } from '@/lib/test-utils/acp'
import { mockTerminal } from '@/lib/test-utils/terminal'
import { expectNotWriteGated, expectWriteGated } from '@/lib/test-utils/write-gate'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { createLeaf } from '@/stores/workspace-store/tree'
import type { Project, Worktree } from '@/types/project'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

const mocks = vi.hoisted(() => ({
  admits: { value: true },
  openTerminal: vi.fn(),
  create: vi.fn(),
  createSymlinks: vi.fn(),
  reconcile: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => mocks.admits.value
}))
vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri-runtime')>()),
  isTauriContext: () => true
}))
vi.mock('@/lib/terminal-spawn', () => ({
  openTerminalAtCwd: (...args: unknown[]) => mocks.openTerminal(...args)
}))
vi.mock('@/lib/worktree-api', () => ({
  worktreeApi: { create: mocks.create, createSymlinks: mocks.createSymlinks }
}))
vi.mock('@/lib/worktree-reconciler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/worktree-reconciler')>()),
  reconcileProjectWorktrees: mocks.reconcile
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))

const wt = (id: string, branch: string, extra: Partial<Worktree> = {}): Worktree => ({
  id,
  name: id,
  branch,
  path: `E:\\proj\\.termul\\worktrees\\${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra
})
const WT_A = wt('a', 'feat/a')
const WT_B = wt('b', 'fix/b')
const WT_EXT = wt('ext', 'ext/branch', { path: 'D:/elsewhere/ext', outsideProjectRoot: true })

function makeProject(extra: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Proj',
    color: 'blue',
    path: 'E:/proj',
    gitBranch: 'main',
    isGitRepo: true,
    worktrees: [WT_A, WT_B, WT_EXT],
    ...extra
  } as Project
}

const initialProjects = useProjectStore.getState().projects

function pickOf(): string | undefined {
  return useShellLayoutStore.getState().worktreePickByProject.p1
}

function Occluded(): React.JSX.Element {
  return <span data-testid="occluded">{String(useNativeWebviewOccluded())}</span>
}

function renderSwitcher(project = makeProject()) {
  useProjectStore.setState({ projects: [project], isWorktreeOperationLocked: false })
  return render(
    <>
      <WorkspaceSwitcher project={project} />
      <Occluded />
    </>
  )
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: /Workspace|feat\/a|fix\/b/ })
}

async function openSwitcher(): Promise<HTMLElement> {
  fireEvent.click(trigger())
  return screen.findByRole('dialog', { name: 'Working copies' })
}

const options = (): HTMLElement[] => screen.getAllByRole('option')
const search = (): HTMLElement => screen.getByLabelText('Search or create a worktree')

describe('WorkspaceSwitcher', () => {
  beforeEach(() => {
    mocks.admits.value = true
    for (const fn of [
      mocks.openTerminal,
      mocks.create,
      mocks.createSymlinks,
      mocks.reconcile,
      mocks.toastSuccess,
      mocks.toastError
    ]) {
      fn.mockReset()
    }
    mocks.openTerminal.mockResolvedValue({ status: 'opened', terminalId: 't' })
    mocks.createSymlinks.mockResolvedValue({ success: true, data: [] })
    resetShellLayoutStoreForTests()
    useShellLayoutStore.setState({ status: 'ready' })
    useAcpStore.setState({ sessions: {} })
    useTerminalStore.setState({ terminals: [] })
    useWorkspaceStore.setState({ root: createLeaf() })
  })
  afterEach(() => {
    cleanup()
    resetNativeWebviewOcclusionForTests()
    useProjectStore.setState({ projects: initialProjects, isWorktreeOperationLocked: false })
  })

  describe('trigger', () => {
    it('reads Workspace without a pick and the picked worktree branch with one', () => {
      renderSwitcher()
      expect(screen.getByRole('button', { name: /Workspace/ })).toBeInTheDocument()
      cleanup()
      useShellLayoutStore.setState({ worktreePickByProject: { p1: 'e:/proj/.termul/worktrees/a' } })
      renderSwitcher()
      expect(screen.getByRole('button', { name: /feat\/a/ })).toBeInTheDocument()
    })

    it('shows the branch in its own case, not as an uppercase section label', () => {
      useShellLayoutStore.setState({ worktreePickByProject: { p1: 'e:/proj/.termul/worktrees/a' } })
      renderSwitcher()
      const label = screen.getByText('feat/a')
      expect(label).not.toHaveClass('label-panel')
      expect(label.closest('button')).toHaveClass('text-foreground')
    })

    it('reads Workspace for a pruned or outside-root pick', () => {
      useShellLayoutStore.setState({
        worktreePickByProject: { p1: 'e:/proj/.termul/worktrees/gone' }
      })
      renderSwitcher()
      expect(screen.getByRole('button', { name: /Workspace/ })).toBeInTheDocument()
      cleanup()
      useShellLayoutStore.setState({ worktreePickByProject: { p1: 'd:/elsewhere/ext' } })
      renderSwitcher()
      expect(screen.getByRole('button', { name: /Workspace/ })).toBeInTheDocument()
    })
  })

  describe('popover', () => {
    it('opens below as a dialog with a search band and a listbox of rows', async () => {
      renderSwitcher()
      const dialog = await openSwitcher()
      expect(dialog).toHaveAttribute('data-side', 'bottom')
      expect(dialog).toHaveAttribute('data-align', 'start')
      expect(search()).toHaveAttribute('placeholder', 'Search or create a worktree…')
      const list = within(dialog).getByRole('listbox', { name: 'Working copies' })
      expect(within(list).getAllByRole('option')).toHaveLength(4)
    })

    it('lists the project folder first, then the worktrees by branch, with the path as title', async () => {
      renderSwitcher()
      await openSwitcher()
      expect(options().map((o) => o.textContent?.replace(OUTSIDE_PROJECT_ROOT_REASON, ''))).toEqual(
        ['main', 'feat/a', 'fix/b', 'ext/branch']
      )
      expect(options()[1]).toHaveAttribute('title', 'E:\\proj\\.termul\\worktrees\\a')
    })

    it('marks the Workspace row when nothing is picked, else the picked worktree', async () => {
      renderSwitcher()
      await openSwitcher()
      expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual([
        'true',
        'false',
        'false',
        'false'
      ])
      cleanup()
      useShellLayoutStore.setState({ worktreePickByProject: { p1: 'e:/proj/.termul/worktrees/b' } })
      renderSwitcher()
      await openSwitcher()
      expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual([
        'false',
        'false',
        'true',
        'false'
      ])
    })

    it('shows the project folder row only for a project that is not a git repo', async () => {
      renderSwitcher(makeProject({ isGitRepo: false }))
      await openSwitcher()
      expect(options()).toHaveLength(1)
      fireEvent.change(search(), { target: { value: 'nothing-here' } })
      expect(screen.getByText('No matching working copies')).toBeInTheDocument()
      expect(screen.queryByText(/Create worktree/)).not.toBeInTheDocument()
    })

    it('hides native webviews while open and releases them on close', async () => {
      renderSwitcher()
      expect(screen.getByTestId('occluded').textContent).toBe('false')
      await openSwitcher()
      await waitFor(() => expect(screen.getByTestId('occluded').textContent).toBe('true'))
      fireEvent.keyDown(search(), { key: 'Escape' })
      await waitFor(() => expect(screen.getByTestId('occluded').textContent).toBe('false'))
    })
  })

  describe('counts and running', () => {
    it('counts tabs per working copy and marks a working one with a dot', async () => {
      useWorkspaceStore.setState({
        root: createLeaf([
          { type: 'agent-chat', id: 'c1', sessionId: 's1' },
          { type: 'agent-chat', id: 'c2', sessionId: 's2' },
          { type: 'terminal', id: 'tt1', terminalId: 't1' },
          { type: 'terminal', id: 'tt2', terminalId: 't2' },
          { type: 'git', id: 'g', cwd: 'E:/proj' }
        ])
      })
      useAcpStore.setState({
        sessions: {
          s1: mockAcpSession({
            id: 's1',
            projectId: 'p1',
            cwd: 'e:\\proj\\.termul\\worktrees\\a\\src',
            activeTurn: true
          }),
          s2: mockAcpSession({ id: 's2', projectId: 'p1', cwd: 'E:/proj' })
        }
      })
      useTerminalStore.setState({
        terminals: [
          mockTerminal({
            id: 't1',
            projectId: 'p1',
            cwd: 'E:/proj/.termul/worktrees/a',
            healthStatus: 'running',
            hasActivity: false
          }),
          mockTerminal({ id: 't2', projectId: 'p1', cwd: 'E:/proj/.termul/worktrees/b' })
        ]
      })
      renderSwitcher()
      await openSwitcher()
      const [folder, a, b] = options()
      expect(within(a).getByTitle('2 open tabs, working')).toHaveTextContent('2')
      expect(within(a).getByTestId('workspace-row-live-dot')).toBeInTheDocument()
      expect(within(b).getByTitle('1 open tab')).toHaveTextContent('1')
      expect(within(b).queryByTestId('workspace-row-live-dot')).not.toBeInTheDocument()
      expect(within(folder).getByTitle('1 open tab')).toHaveTextContent('1')
    })

    it('marks a worktree working for a running terminal with activity', async () => {
      useTerminalStore.setState({
        terminals: [
          mockTerminal({
            id: 't1',
            projectId: 'p1',
            cwd: 'E:/proj/.termul/worktrees/b',
            healthStatus: 'running',
            hasActivity: true
          })
        ]
      })
      renderSwitcher()
      await openSwitcher()
      expect(within(options()[2]).getByTestId('workspace-row-live-dot')).toBeInTheDocument()
    })
  })

  describe('picking', () => {
    it('picks a worktree row and closes the popover', async () => {
      renderSwitcher()
      await openSwitcher()
      fireEvent.click(options()[1])
      expect(pickOf()).toBe('e:/proj/.termul/worktrees/a')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(screen.getByRole('button', { name: /feat\/a/ })).toBeInTheDocument()
    })

    it('clears the pick from the Workspace row', async () => {
      useShellLayoutStore.setState({ worktreePickByProject: { p1: 'e:/proj/.termul/worktrees/a' } })
      renderSwitcher()
      await openSwitcher()
      fireEvent.click(options()[0])
      expect(pickOf()).toBeUndefined()
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('filters rows by a case-insensitive substring of the label', async () => {
      renderSwitcher()
      await openSwitcher()
      fireEvent.change(search(), { target: { value: 'FIX' } })
      expect(options().map((o) => o.textContent)).toEqual(['fix/b'])
    })

    it('moves the highlight with Up/Down and activates with Enter', async () => {
      renderSwitcher()
      await openSwitcher()
      fireEvent.keyDown(search(), { key: 'ArrowDown' })
      fireEvent.keyDown(search(), { key: 'ArrowDown' })
      fireEvent.keyDown(search(), { key: 'ArrowUp' })
      fireEvent.keyDown(search(), { key: 'Enter' })
      // Folder -> a -> b -> a.
      expect(pickOf()).toBe('e:/proj/.termul/worktrees/a')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('closes with Escape and returns focus to the trigger', async () => {
      renderSwitcher()
      await openSwitcher()
      fireEvent.keyDown(search(), { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() => expect(trigger()).toHaveFocus())
      expect(pickOf()).toBeUndefined()
    })

    it('disables an outside-root row with the reason and never picks it', async () => {
      renderSwitcher()
      await openSwitcher()
      const ext = options()[3]
      expect(ext).toHaveAttribute('aria-disabled', 'true')
      expect(ext).toHaveAttribute('title', OUTSIDE_PROJECT_ROOT_REASON)
      expect(within(ext).getByText(OUTSIDE_PROJECT_ROOT_REASON)).toHaveClass('sr-only')
      fireEvent.click(ext)
      expect(pickOf()).toBeUndefined()
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open terminal in ext/branch' })).toBeDisabled()
    })
  })

  describe('terminal action', () => {
    it('opens a terminal at the row path without touching the pick, then closes', async () => {
      useShellLayoutStore.setState({ worktreePickByProject: { p1: 'e:/proj/.termul/worktrees/b' } })
      renderSwitcher()
      await openSwitcher()
      const button = screen.getByRole('button', { name: 'Open terminal in feat/a' })
      expect(button).toHaveAttribute('title', 'Open terminal at E:\\proj\\.termul\\worktrees\\a')
      expect(button).not.toHaveAttribute('tabindex', '-1')
      fireEvent.click(button)
      await waitFor(() =>
        expect(mocks.openTerminal).toHaveBeenCalledWith('p1', 'E:\\proj\\.termul\\worktrees\\a')
      )
      expect(pickOf()).toBe('e:/proj/.termul/worktrees/b')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Terminal opened', {
        description: 'Opened at E:\\proj\\.termul\\worktrees\\a'
      })
    })

    it('opens the project folder terminal from the Workspace row', async () => {
      renderSwitcher()
      await openSwitcher()
      fireEvent.click(screen.getByRole('button', { name: 'Open terminal in main' }))
      await waitFor(() => expect(mocks.openTerminal).toHaveBeenCalledWith('p1', 'E:/proj'))
    })

    it('offers Open Terminal Here on the row context menu with the same behaviour', async () => {
      renderSwitcher()
      await openSwitcher()
      fireEvent.contextMenu(options()[2])
      fireEvent.click(await screen.findByRole('menuitem', { name: /Open Terminal Here/ }))
      await waitFor(() =>
        expect(mocks.openTerminal).toHaveBeenCalledWith('p1', 'E:\\proj\\.termul\\worktrees\\b')
      )
      expect(pickOf()).toBeUndefined()
    })

    it('toasts when there is no active pane or the spawn fails', async () => {
      mocks.openTerminal.mockResolvedValueOnce({ status: 'no-pane' })
      renderSwitcher()
      await openSwitcher()
      fireEvent.click(screen.getByRole('button', { name: 'Open terminal in main' }))
      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith('No active pane', {
          description: 'Cannot open terminal without an active workspace pane.'
        })
      )

      cleanup()
      mocks.openTerminal.mockResolvedValueOnce({ status: 'spawn-failed', error: 'nope' })
      renderSwitcher()
      await openSwitcher()
      fireEvent.click(screen.getByRole('button', { name: 'Open terminal in main' }))
      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith('Failed to open terminal', {
          description: 'nope'
        })
      )
    })
  })

  describe('create worktree', () => {
    async function typeNoMatch(value: string): Promise<void> {
      await openSwitcher()
      fireEvent.change(search(), { target: { value } })
    }

    it('shows the empty line, a hairline and a sanitized create row for a query with no match', async () => {
      renderSwitcher()
      await typeNoMatch('  fix login!  ')
      expect(screen.getByText('No matching working copies')).toBeInTheDocument()
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      const row = screen.getByRole('button', { name: /Create worktree fix-login/ })
      expectNotWriteGated(row)
    })

    it('shows no create row when the query sanitizes to nothing', async () => {
      renderSwitcher()
      await typeNoMatch('!!!')
      expect(screen.getByText('No matching working copies')).toBeInTheDocument()
      expect(screen.queryByText(/Create worktree/)).not.toBeInTheDocument()
    })

    it('creates, reconciles, then picks the new worktree and closes', async () => {
      const created = 'E:/proj/.termul/worktrees/fix-login'
      mocks.create.mockResolvedValue({
        success: true,
        data: { name: 'fix-login', branch: 'fix-login', path: created, headCommit: '' }
      })
      mocks.reconcile.mockImplementation(async () => {
        // The pick must not exist before the reconcile settles.
        expect(pickOf()).toBeUndefined()
        useProjectStore.setState((s) => ({
          projects: s.projects.map((p) => ({
            ...p,
            worktrees: [...(p.worktrees ?? []), wt('fix-login', 'fix-login', { path: created })]
          }))
        }))
        return 'updated'
      })
      renderSwitcher()
      await typeNoMatch('fix login')
      fireEvent.click(screen.getByRole('button', { name: /Create worktree fix-login/ }))

      await waitFor(() => expect(pickOf()).toBe('e:/proj/.termul/worktrees/fix-login'))
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: 'E:/proj',
          name: 'fix-login',
          branch: 'fix-login',
          isNewBranch: true
        })
      )
      expect(mocks.reconcile).toHaveBeenCalledWith('p1')
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Worktree created')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('refuses inline while another worktree operation holds the lock', async () => {
      renderSwitcher()
      await typeNoMatch('zzz')
      useProjectStore.setState({ isWorktreeOperationLocked: true })
      fireEvent.click(screen.getByRole('button', { name: /Create worktree zzz/ }))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Another worktree operation is in progress'
      )
      expect(mocks.create).not.toHaveBeenCalled()
    })

    it('toasts and never picks when the create fails', async () => {
      mocks.create.mockResolvedValue({ success: false, error: 'boom', code: 'X' })
      renderSwitcher()
      await typeNoMatch('zzz')
      fireEvent.click(screen.getByRole('button', { name: /Create worktree zzz/ }))
      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith('Failed to create worktree', {
          description: 'boom'
        })
      )
      expect(pickOf()).toBeUndefined()
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('disables the create row with the read-only reason and calls nothing on a read-only server', async () => {
      mocks.admits.value = false
      renderSwitcher()
      await typeNoMatch('zzz')
      const row = screen.getByRole('button', { name: /Create worktree zzz/ })
      expectWriteGated(row)
      expect(row.className).toContain('opacity-40')
      expect(row.className).toContain('cursor-not-allowed')
      await act(async () => {
        fireEvent.click(row)
        fireEvent.keyDown(search(), { key: 'Enter' })
      })
      expect(mocks.create).not.toHaveBeenCalled()
      expect(mocks.reconcile).not.toHaveBeenCalled()
    })
  })
})
