import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetSheetFocusReturnForTests,
  recordSheetOpener,
  sheetCloseAutoFocus
} from '@/lib/sheet-focus-return'
import { mockAcpSession } from '@/lib/test-utils/acp'
import type { Project } from '@/types/project'

const { logFrontendError } = vi.hoisted(() => ({ logFrontendError: vi.fn(async () => {}) }))
vi.mock('@/lib/log-api', () => ({ logFrontendError }))

const { sessionsRef } = vi.hoisted(() => ({
  sessionsRef: { current: {} as Record<string, { cwd: string }> }
}))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: { getState: () => ({ sessions: sessionsRef.current }) }
}))

import { resolveGitSheetCwd, useGitSheetStore } from './git-sheet-store'
import { useProjectStore } from './project-store'
import { useWorkspaceStore, type WorkspaceTab } from './workspace-store'

function project(overrides: Partial<Project> = {}): Project {
  return { id: 'p1', name: 'Demo', color: 'blue', path: '/repo', ...overrides } as Project
}

function seedActiveTab(tab: WorkspaceTab): void {
  useWorkspaceStore.setState({
    root: { type: 'leaf', id: 'pane-1', tabs: [tab], activeTabId: tab.id },
    activePaneId: 'pane-1'
  })
}

const CHAT_TAB: WorkspaceTab = { type: 'agent-chat', id: 'chat-s1', sessionId: 's1' }
const TERMINAL_TAB: WorkspaceTab = { type: 'terminal', id: 'term-1', terminalId: 't1' }

describe('resolveGitSheetCwd', () => {
  it('prefers an explicit cwd over everything else', () => {
    expect(
      resolveGitSheetCwd({
        explicitCwd: '/repo/.worktrees/a',
        activeTab: { type: 'agent-chat' },
        sessionCwd: '/other',
        activeWorktreeRoot: '/wt',
        projectPath: '/repo'
      })
    ).toEqual({ cwd: '/repo/.worktrees/a', source: 'explicit' })
  })

  it('ignores a blank explicit cwd', () => {
    expect(resolveGitSheetCwd({ explicitCwd: '  ', projectPath: '/repo' })).toEqual({
      cwd: '/repo',
      source: 'project'
    })
  })

  it("uses the active chat's session cwd when the active tab is a chat", () => {
    expect(
      resolveGitSheetCwd({
        activeTab: { type: 'agent-chat' },
        sessionCwd: '/repo/.worktrees/b',
        activeWorktreeRoot: '/wt',
        projectPath: '/repo'
      })
    ).toEqual({ cwd: '/repo/.worktrees/b', source: 'active-chat' })
  })

  it('ignores the session cwd when the active tab is not a chat', () => {
    expect(
      resolveGitSheetCwd({
        activeTab: { type: 'terminal' },
        sessionCwd: '/repo/.worktrees/b',
        activeWorktreeRoot: '/wt',
        projectPath: '/repo'
      })
    ).toEqual({ cwd: '/wt', source: 'active-worktree' })
  })

  it('falls through a chat with no cwd to the worktree root, then the project path', () => {
    expect(
      resolveGitSheetCwd({
        activeTab: { type: 'agent-chat' },
        sessionCwd: '',
        activeWorktreeRoot: '/wt',
        projectPath: '/repo'
      })
    ).toEqual({ cwd: '/wt', source: 'active-worktree' })
    expect(
      resolveGitSheetCwd({ activeTab: null, activeWorktreeRoot: null, projectPath: '/repo' })
    ).toEqual({ cwd: '/repo', source: 'project' })
  })

  it('returns null when nothing resolves', () => {
    expect(resolveGitSheetCwd({})).toBeNull()
    expect(resolveGitSheetCwd({ explicitCwd: null, projectPath: '' })).toBeNull()
  })
})

describe('useGitSheetStore', () => {
  beforeEach(() => {
    logFrontendError.mockClear()
    _resetSheetFocusReturnForTests()
    sessionsRef.current = {}
    useGitSheetStore.setState({ open: false, cwd: '', projectId: '' })
    useProjectStore.setState({ projects: [project()], activeProjectId: 'p1' })
    useWorkspaceStore.setState({
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      activePaneId: 'pane-1'
    })
  })

  it('opens on an explicit cwd and records the active project', () => {
    useGitSheetStore.getState().openGitSheet('/repo/.worktrees/a')
    expect(useGitSheetStore.getState()).toMatchObject({
      open: true,
      cwd: '/repo/.worktrees/a',
      projectId: 'p1'
    })
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', message: expect.stringContaining('explicit') })
    )
  })

  it('does not read the workspace or acp stores when the cwd is explicit', () => {
    const workspaceSpy = vi.spyOn(useWorkspaceStore, 'getState')
    useGitSheetStore.getState().openGitSheet('/repo/.worktrees/a')
    expect(workspaceSpy).not.toHaveBeenCalled()
    workspaceSpy.mockRestore()
  })

  it("opens on the active chat's session cwd", () => {
    seedActiveTab(CHAT_TAB)
    sessionsRef.current = { s1: mockAcpSession({ id: 's1', cwd: '/repo/.worktrees/chat' }) }
    useGitSheetStore.getState().openGitSheet()
    expect(useGitSheetStore.getState()).toMatchObject({ open: true, cwd: '/repo/.worktrees/chat' })
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', message: expect.stringContaining('active-chat') })
    )
  })

  it('opens on the active worktree root from any other tab', () => {
    seedActiveTab(TERMINAL_TAB)
    useProjectStore.setState({
      projects: [
        project({
          activeWorktreeId: 'w1',
          worktrees: [{ id: 'w1', name: 'feat', path: '/repo/.worktrees/feat' }] as never
        })
      ]
    })
    useGitSheetStore.getState().openGitSheet()
    expect(useGitSheetStore.getState()).toMatchObject({
      open: true,
      cwd: '/repo/.worktrees/feat',
      projectId: 'p1'
    })
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        message: expect.stringContaining('active-worktree')
      })
    )
  })

  it('falls back to the project path with no chat and no worktree', () => {
    useGitSheetStore.getState().openGitSheet()
    expect(useGitSheetStore.getState()).toMatchObject({ open: true, cwd: '/repo' })
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', message: expect.stringContaining('project') })
    )
  })

  it('stays closed and warns when no cwd resolves', () => {
    useProjectStore.setState({ projects: [project({ path: undefined })] })
    useGitSheetStore.getState().openGitSheet()
    expect(useGitSheetStore.getState().open).toBe(false)
    expect(logFrontendError).toHaveBeenCalledTimes(1)
    expect(logFrontendError).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })

  describe('focus-return opener', () => {
    const closeEvent = (): Event => new Event('focusScope.autoFocusOnUnmount', { cancelable: true })
    const mountButton = (): HTMLButtonElement => {
      const button = document.createElement('button')
      document.body.append(button)
      return button
    }

    afterEach(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      document.body.innerHTML = ''
    })

    it('records the opener when the sheet opens, so closing returns focus to it', () => {
      const gitAction = mountButton()
      useGitSheetStore.getState().openGitSheet('/repo/.worktrees/a', gitAction)
      expect(useGitSheetStore.getState().open).toBe(true)

      sheetCloseAutoFocus('git-sheet')(closeEvent())

      expect(document.activeElement).toBe(gitAction)
    })

    it('keeps an opener a caller already recorded (the header ⋯ row) when none is passed', () => {
      const more = mountButton()
      recordSheetOpener('git-sheet', more)

      useGitSheetStore.getState().openGitSheet()
      expect(useGitSheetStore.getState().open).toBe(true)
      sheetCloseAutoFocus('git-sheet')(closeEvent())

      expect(document.activeElement).toBe(more)
    })

    it('replaces an earlier opener with the one passed', () => {
      const more = mountButton()
      const gitAction = mountButton()
      recordSheetOpener('git-sheet', more)

      useGitSheetStore.getState().openGitSheet('/repo', gitAction)
      sheetCloseAutoFocus('git-sheet')(closeEvent())

      expect(document.activeElement).toBe(gitAction)
    })

    it('records nothing when the sheet does not open', () => {
      const more = mountButton()
      const gitAction = mountButton()
      recordSheetOpener('git-sheet', more)
      useProjectStore.setState({ projects: [project({ path: undefined })] })

      useGitSheetStore.getState().openGitSheet(undefined, gitAction)
      expect(useGitSheetStore.getState().open).toBe(false)
      sheetCloseAutoFocus('git-sheet')(closeEvent())

      expect(document.activeElement).toBe(more)
    })
  })

  it('closes without dropping the cwd, so the exit animation keeps its content', () => {
    useGitSheetStore.getState().openGitSheet('/repo/x')
    useGitSheetStore.getState().closeGitSheet()
    expect(useGitSheetStore.getState()).toMatchObject({ open: false, cwd: '/repo/x' })
  })
})
