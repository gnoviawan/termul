import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizePath } from '@/lib/working-copy'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { useProjectStore } from '@/stores/project-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import type { Project, Worktree } from '@/types/project'
import { useWorktreeShortcuts, WORKTREE_EVENTS } from '../use-worktree-shortcuts'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))

const ROOT = 'E:/p'

function wt(id: string, path: string, extra: Partial<Worktree> = {}): Worktree {
  return { id, name: id, branch: `b-${id}`, path, createdAt: '2026-01-01T00:00:00.000Z', ...extra }
}

// Deliberately stored out of canonical order to prove the cycle sorts by path.
const WORKTREES: Worktree[] = [
  wt('c', 'E:/p/.termul/worktrees/c'),
  wt('a', 'E:/p/.termul/worktrees/a'),
  wt('ext', 'D:/elsewhere/wt', { outsideProjectRoot: true }),
  wt('b', 'E:\\p\\.termul\\worktrees\\B\\')
]

function seed(worktrees: Worktree[] = WORKTREES): void {
  useProjectStore.setState({
    projects: [{ id: 'p1', name: 'P', color: 'blue', path: ROOT, worktrees } as Project],
    activeProjectId: 'p1'
  })
}

function setPick(path: string | null): void {
  useShellLayoutStore.setState({
    worktreePickByProject: path === null ? {} : { p1: normalizePath(path) }
  })
}

function pick(): string | undefined {
  return useShellLayoutStore.getState().worktreePickByProject.p1
}

function press(key: string): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true, cancelable: true })
  )
}
const next = () => press('ArrowDown')
const prev = () => press('ArrowUp')
const root = () => press('Home')

beforeEach(() => {
  resetShellLayoutStoreForTests()
  // `unavailable` is usable in memory and never touches persistence.
  useShellLayoutStore.setState({ status: 'unavailable' })
  // Fixed bindings, independent of the platform-aware defaults.
  const keys = useKeyboardShortcutsStore.getState()
  keys.resetAllShortcuts()
  keys.updateShortcut('worktreeSwitchNext', 'ctrl+shift+arrowdown')
  keys.updateShortcut('worktreeSwitchPrev', 'ctrl+shift+arrowup')
  keys.updateShortcut('worktreeSwitchRoot', 'ctrl+shift+home')
  seed()
})

describe('useWorktreeShortcuts: switcher pick', () => {
  it('cycles next in canonical path order, skipping disabled worktrees, and wraps', () => {
    renderHook(() => useWorktreeShortcuts())
    setPick('E:/p/.termul/worktrees/a')

    next()
    expect(pick()).toBe('e:/p/.termul/worktrees/b')
    next()
    expect(pick()).toBe('e:/p/.termul/worktrees/c')
    next()
    expect(pick()).toBe('e:/p/.termul/worktrees/a')
  })

  it('cycles prev and wraps among worktrees only', () => {
    renderHook(() => useWorktreeShortcuts())
    setPick('E:/p/.termul/worktrees/b')

    prev()
    expect(pick()).toBe('e:/p/.termul/worktrees/a')
    prev()
    expect(pick()).toBe('e:/p/.termul/worktrees/c')
  })

  it('from the project folder next goes to the first and prev to the last', () => {
    renderHook(() => useWorktreeShortcuts())

    next()
    expect(pick()).toBe('e:/p/.termul/worktrees/a')

    setPick(null)
    prev()
    expect(pick()).toBe('e:/p/.termul/worktrees/c')
  })

  it('treats a stale or disabled pick as the project folder', () => {
    renderHook(() => useWorktreeShortcuts())

    setPick('E:/p/.termul/worktrees/gone')
    next()
    expect(pick()).toBe('e:/p/.termul/worktrees/a')

    setPick('D:/elsewhere/wt')
    prev()
    expect(pick()).toBe('e:/p/.termul/worktrees/c')
  })

  it('reads the current pick at event time, not at render time', () => {
    renderHook(() => useWorktreeShortcuts())
    setPick('E:/p/.termul/worktrees/a')
    next()
    // A pick written elsewhere after render is honoured by the next keypress.
    setPick('E:/p/.termul/worktrees/c')
    next()
    expect(pick()).toBe('e:/p/.termul/worktrees/a')
  })

  it('root clears the pick', () => {
    renderHook(() => useWorktreeShortcuts())
    setPick('E:/p/.termul/worktrees/a')

    root()
    expect(pick()).toBeUndefined()
  })

  it('does not write when the project has no cyclable worktrees', () => {
    seed([wt('ext', 'D:/elsewhere/wt', { outsideProjectRoot: true })])
    renderHook(() => useWorktreeShortcuts())
    const setWorktreePick = vi.spyOn(useShellLayoutStore.getState(), 'setWorktreePick')

    next()
    prev()
    expect(setWorktreePick).not.toHaveBeenCalled()

    seed([])
    next()
    expect(setWorktreePick).not.toHaveBeenCalled()
  })

  it('does nothing without an active project', () => {
    useProjectStore.setState({ activeProjectId: '' })
    renderHook(() => useWorktreeShortcuts())
    next()
    expect(pick()).toBeUndefined()
  })
})

describe('useWorktreeShortcuts: default bindings', () => {
  beforeEach(() => {
    // Defaults only: no custom keys, so the shipped key strings are what fire.
    useKeyboardShortcutsStore.getState().resetAllShortcuts()
  })

  it('Ctrl+Shift+Down / Up / Home drive the pick with the default bindings', () => {
    renderHook(() => useWorktreeShortcuts())
    setPick(null)

    next()
    expect(pick()).toBe('e:/p/.termul/worktrees/a')
    next()
    expect(pick()).toBe('e:/p/.termul/worktrees/b')
    prev()
    expect(pick()).toBe('e:/p/.termul/worktrees/a')
    root()
    expect(pick()).toBeUndefined()
  })

  it('a binding saved in the legacy downarrow spelling still fires', () => {
    useKeyboardShortcutsStore
      .getState()
      .updateShortcut('worktreeSwitchNext', 'ctrl+shift+downarrow')
    renderHook(() => useWorktreeShortcuts())
    setPick(null)

    next()
    expect(pick()).toBe('e:/p/.termul/worktrees/a')
  })
})

describe('useWorktreeShortcuts: create worktree (issue #1184)', () => {
  beforeEach(() => {
    useKeyboardShortcutsStore.getState().resetAllShortcuts()
  })

  it('the Create Worktree binding opens the create flow for the active project', () => {
    const received: unknown[] = []
    const listener = (event: Event): void => {
      received.push((event as CustomEvent).detail)
    }
    window.addEventListener(WORKTREE_EVENTS.OPEN_CREATE_MODAL, listener)
    renderHook(() => useWorktreeShortcuts())

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'n',
        ctrlKey: true,
        shiftKey: true,
        altKey: true,
        cancelable: true
      })
    )

    window.removeEventListener(WORKTREE_EVENTS.OPEN_CREATE_MODAL, listener)
    expect(received).toEqual([{ projectId: 'p1' }])
  })

  it('has no merge, sync or archive shortcut: their dialogs do not exist', () => {
    const ids = Object.keys(useKeyboardShortcutsStore.getState().shortcuts)
    expect(ids).not.toContain('worktreeMergeToMain')
    expect(ids).not.toContain('worktreeSyncMain')
    expect(ids).not.toContain('worktreeArchive')
    expect(Object.keys(WORKTREE_EVENTS).sort()).toEqual(['OPEN_CREATE_MODAL', 'OPEN_TERMINAL'])
  })
})
