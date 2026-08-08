import type { FileChangeEvent } from '@shared/types/filesystem.types'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileWatcher } from './use-file-watcher'

type WatchHandler = (event: FileChangeEvent) => void
type FileState = { isDirty: boolean; lastModified: number; operationStatus?: string }

/**
 * Shared mocks hoisted above imports: the facades/stores mocked below capture
 * these at module-evaluation time, before the test body runs.
 */
const mocks = vi.hoisted(() => ({
  handlers: {
    changed: null as WatchHandler | null,
    created: null as WatchHandler | null,
    deleted: null as WatchHandler | null
  },
  editorOpenFiles: new Map<string, FileState>(),
  expandedDirs: new Set<string>(),
  closeFileIfIdle: vi.fn(),
  reloadFile: vi.fn(),
  removeTab: vi.fn(),
  refreshDirectory: vi.fn(),
  consumeEditorSelfSave: vi.fn(),
  scheduleGitStatusRefreshForPath: vi.fn(),
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  })
}))

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    onFileChanged: vi.fn((cb: WatchHandler) => {
      mocks.handlers.changed = cb
      return () => {
        mocks.handlers.changed = null
      }
    }),
    onFileCreated: vi.fn((cb: WatchHandler) => {
      mocks.handlers.created = cb
      return () => {
        mocks.handlers.created = null
      }
    }),
    onFileDeleted: vi.fn((cb: WatchHandler) => {
      mocks.handlers.deleted = cb
      return () => {
        mocks.handlers.deleted = null
      }
    })
  }
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: {
    getState: () => ({
      openFiles: mocks.editorOpenFiles,
      closeFileIfIdle: mocks.closeFileIfIdle,
      reloadFile: mocks.reloadFile
    })
  }
}))

vi.mock('@/stores/file-explorer-store', () => ({
  useFileExplorerStore: {
    getState: () => ({
      expandedDirs: mocks.expandedDirs,
      refreshDirectory: mocks.refreshDirectory
    })
  }
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: () => ({
      removeTab: mocks.removeTab
    })
  },
  editorTabId: (filePath: string) => `edit-${filePath}`
}))

vi.mock('@/lib/editor-self-save', () => ({
  consumeEditorSelfSave: mocks.consumeEditorSelfSave
}))

vi.mock('@/lib/schedule-git-status-refresh', () => ({
  scheduleGitStatusRefreshForPath: mocks.scheduleGitStatusRefreshForPath
}))

vi.mock('sonner', () => ({
  toast: mocks.toast
}))

function WatcherHost(): null {
  useFileWatcher()
  return null
}

function renderWatcher(): ReturnType<typeof render> {
  return render(createElement(WatcherHost))
}

/** Advance past the explorer refresh debounce (300ms). */
async function flushRefreshDebounce(): Promise<void> {
  vi.advanceTimersByTime(350)
}

describe('useFileWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.editorOpenFiles = new Map()
    mocks.expandedDirs = new Set()
    mocks.closeFileIfIdle.mockReturnValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setOpenedFile(path: string, overrides: Partial<FileState> = {}): void {
    mocks.editorOpenFiles.set(path, {
      isDirty: false,
      lastModified: Date.now() - 10_000,
      operationStatus: 'idle',
      ...overrides
    })
  }

  describe('change events never close tabs (GH-539)', () => {
    it('suppresses a change event for a self-saved file without closing its tab', () => {
      setOpenedFile('/project/notes.md')
      mocks.consumeEditorSelfSave.mockReturnValue(true)

      render(<WatcherHost />)
      mocks.handlers.changed?.({ type: 'change', path: '/project/notes.md' })

      expect(mocks.consumeEditorSelfSave).toHaveBeenCalledWith('/project/notes.md')
      expect(mocks.reloadFile).not.toHaveBeenCalled()
      expect(mocks.closeFileIfIdle).not.toHaveBeenCalled()
      expect(mocks.removeTab).not.toHaveBeenCalled()
      expect(mocks.toast).not.toHaveBeenCalled()
    })

    it('skips a change event within the 2s lastModified grace window', () => {
      setOpenedFile('/project/notes.md', { lastModified: Date.now() - 500 })
      mocks.consumeEditorSelfSave.mockReturnValue(false)

      render(<WatcherHost />)
      mocks.handlers.changed?.({ type: 'change', path: '/project/notes.md' })

      expect(mocks.reloadFile).not.toHaveBeenCalled()
      expect(mocks.closeFileIfIdle).not.toHaveBeenCalled()
      expect(mocks.removeTab).not.toHaveBeenCalled()
      expect(mocks.toast).not.toHaveBeenCalled()
    })

    it('silently reloads a clean file changed externally outside the grace window', () => {
      setOpenedFile('/project/notes.md')
      mocks.consumeEditorSelfSave.mockReturnValue(false)

      render(<WatcherHost />)
      mocks.handlers.changed?.({ type: 'change', path: '/project/notes.md' })

      expect(mocks.reloadFile).toHaveBeenCalledWith('/project/notes.md')
      expect(mocks.closeFileIfIdle).not.toHaveBeenCalled()
      expect(mocks.removeTab).not.toHaveBeenCalled()
      expect(mocks.toast).not.toHaveBeenCalled()
    })

    it('prompts before reloading a dirty file changed externally', () => {
      setOpenedFile('/project/notes.md', { isDirty: true })
      mocks.consumeEditorSelfSave.mockReturnValue(false)

      render(<WatcherHost />)
      mocks.handlers.changed?.({ type: 'change', path: '/project/notes.md' })

      expect(mocks.toast).toHaveBeenCalledWith(
        'File changed externally',
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Reload' })
        })
      )
      expect(mocks.reloadFile).not.toHaveBeenCalled()
      expect(mocks.closeFileIfIdle).not.toHaveBeenCalled()
      expect(mocks.removeTab).not.toHaveBeenCalled()
    })

    it('does not close the tab when a non-unlink event reaches the delete handler', () => {
      // Defense in depth: even if a 'change' event were delivered to the
      // delete subscription, it must never close an open tab. Git refresh and
      // explorer refresh scheduling still run for every event type.
      setOpenedFile('/project/notes.md')
      mocks.expandedDirs.add('/project')

      render(<WatcherHost />)
      mocks.handlers.deleted?.({ type: 'change', path: '/project/notes.md' })

      expect(mocks.scheduleGitStatusRefreshForPath).toHaveBeenCalledWith('/project/notes.md')
      expect(mocks.closeFileIfIdle).not.toHaveBeenCalled()
      expect(mocks.removeTab).not.toHaveBeenCalled()

      // Debounced explorer refresh still fires for the parent directory.
      flushRefreshDebounce()
      expect(mocks.refreshDirectory).toHaveBeenCalledWith('/project')
    })
  })

  describe('unlink events close tabs', () => {
    it('closes and removes the workspace tab when an open file is deleted', () => {
      setOpenedFile('/project/notes.md')

      render(<WatcherHost />)
      mocks.handlers.deleted?.({ type: 'unlink', path: '/project/notes.md' })

      expect(mocks.closeFileIfIdle).toHaveBeenCalledWith('/project/notes.md')
      expect(mocks.removeTab).toHaveBeenCalledWith('edit-/project/notes.md')
    })

    it('keeps the workspace tab when closeFileIfIdle refuses (busy file)', () => {
      setOpenedFile('/project/notes.md', { operationStatus: 'saving' })
      mocks.closeFileIfIdle.mockReturnValue(false)

      render(<WatcherHost />)
      mocks.handlers.deleted?.({ type: 'unlink', path: '/project/notes.md' })

      expect(mocks.closeFileIfIdle).toHaveBeenCalledWith('/project/notes.md')
      expect(mocks.removeTab).not.toHaveBeenCalled()
    })

    it('does nothing for an unlink of a file that is not open', () => {
      render(<WatcherHost />)
      mocks.handlers.deleted?.({ type: 'unlink', path: '/project/other.md' })

      expect(mocks.closeFileIfIdle).not.toHaveBeenCalled()
      expect(mocks.removeTab).not.toHaveBeenCalled()
    })
  })

  describe('created events refresh the explorer', () => {
    it('refreshes the expanded parent directory after the debounce', () => {
      mocks.expandedDirs.add('/project/src')

      render(<WatcherHost />)
      mocks.handlers.created?.({ type: 'add', path: '/project/src/new.ts' })

      expect(mocks.scheduleGitStatusRefreshForPath).toHaveBeenCalledWith('/project/src/new.ts')
      expect(mocks.refreshDirectory).not.toHaveBeenCalled()

      flushRefreshDebounce()
      expect(mocks.refreshDirectory).toHaveBeenCalledWith('/project/src')
    })

    it('skips the refresh when the parent directory is not expanded', () => {
      render(<WatcherHost />)
      mocks.handlers.created?.({ type: 'add', path: '/project/src/new.ts' })

      flushRefreshDebounce()
      expect(mocks.refreshDirectory).not.toHaveBeenCalled()
    })
  })

  describe('subscriptions', () => {
    it('registers all three typed subscriptions and unsubscribes on unmount', () => {
      const { unmount } = render(<WatcherHost />)

      expect(mocks.handlers.changed).not.toBeNull()
      expect(mocks.handlers.created).not.toBeNull()
      expect(mocks.handlers.deleted).not.toBeNull()

      unmount()

      expect(mocks.handlers.changed).toBeNull()
      expect(mocks.handlers.created).toBeNull()
      expect(mocks.handlers.deleted).toBeNull()
    })
  })
})
