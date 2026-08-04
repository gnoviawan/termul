import type { FileChangeEvent } from '@shared/types/filesystem.types'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorFileState } from '@/stores/editor-store'
import { useEditorStore } from '@/stores/editor-store'
import { useFileWatcher } from './use-file-watcher'

/**
 * End-to-end regression for the GH-539 disappearing-editor bug: save through
 * the REAL editor store (write + self-save marker) and deliver the resulting
 * watcher events through the REAL useFileWatcher handlers. A save must never
 * close the tab; a genuine unlink must.
 */

type WatchHandler = (event: FileChangeEvent) => void

const mocks = vi.hoisted(() => ({
  handlers: {
    changed: null as WatchHandler | null,
    created: null as WatchHandler | null,
    deleted: null as WatchHandler | null
  },
  writeFile: vi.fn(),
  readFile: vi.fn(),
  removeTab: vi.fn(),
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
    }),
    writeFile: mocks.writeFile,
    readFile: mocks.readFile
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

vi.mock('@/lib/schedule-git-status-refresh', () => ({
  scheduleGitStatusRefreshForPath: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: mocks.toast
}))

function WatcherHost(): null {
  useFileWatcher()
  return null
}

const path = '/project/notes.md'

function seedOpenFile(): void {
  const fileState: EditorFileState = {
    filePath: path,
    content: 'edited content',
    originalContent: 'original content',
    isDirty: true,
    language: 'markdown',
    lastModified: 0,
    viewMode: 'code',
    cursorPosition: { line: 1, col: 1 },
    scrollTop: 0,
    operationStatus: 'idle'
  }
  useEditorStore.setState({ openFiles: new Map([[path, fileState]]), activeFilePath: path })
}

describe('save → file watcher integration (GH-539)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.writeFile.mockResolvedValue({ success: true, data: undefined })
    seedOpenFile()
  })

  afterEach(() => {
    useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
    vi.useRealTimers()
  })

  it('saving a file keeps its tab open across the watcher events the save generates', async () => {
    render(createElement(WatcherHost))

    const saved = await useEditorStore.getState().saveFile(path)
    expect(saved).toBe(true)
    expect(mocks.writeFile).toHaveBeenCalledWith(path, 'edited content')

    // The OS watcher reports our own write as a change event (typed dispatch
    // routes modify → changed subscription). The tab must survive it.
    mocks.handlers.changed?.({ type: 'change', path })

    const file = useEditorStore.getState().openFiles.get(path)
    expect(file).toBeDefined()
    expect(file?.isDirty).toBe(false)
    expect(mocks.removeTab).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()

    // A second change event inside the lastModified grace window is also safe.
    mocks.handlers.changed?.({ type: 'change', path })
    expect(useEditorStore.getState().openFiles.get(path)).toBeDefined()
    expect(mocks.removeTab).not.toHaveBeenCalled()
  })

  it('a genuine external delete still closes the tab after a save', async () => {
    render(createElement(WatcherHost))

    await useEditorStore.getState().saveFile(path)

    mocks.handlers.deleted?.({ type: 'unlink', path })

    expect(useEditorStore.getState().openFiles.get(path)).toBeUndefined()
    expect(mocks.removeTab).toHaveBeenCalledWith(`edit-${path}`)
  })
})
