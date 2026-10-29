import { render } from '@testing-library/react'
import { createElement } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import notifyWatchEvents from '@/lib/__tests__/fixtures/notify-watch-events.json'
import { filesystemApi } from '@/lib/api'
import { _resetFilesystemStateForTesting } from '@/lib/tauri-filesystem-api'
import type { EditorFileState } from '@/stores/editor-store'
import { useEditorStore } from '@/stores/editor-store'
import { useFileWatcher } from './use-file-watcher'

type WatchEvent = { type: unknown; paths: string[]; attrs: object }

const mocks = vi.hoisted(() => ({
  emit: null as ((event: unknown) => void) | null,
  disk: new Map<string, string>(),
  removeTab: vi.fn()
}))

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => true }))

vi.mock('@tauri-apps/plugin-fs', () => {
  const missing = (path: string) => new Error(`No such file or directory: ${path}`)
  return {
    watchImmediate: vi.fn(async (_paths: string[], callback: (event: unknown) => void) => {
      mocks.emit = callback
      return () => {}
    }),
    stat: vi.fn(async (path: string) => {
      const content = mocks.disk.get(path)
      if (content === undefined) throw missing(path)
      return { isFile: true, isDirectory: false, size: content.length, mtime: new Date(0) }
    }),
    readTextFile: vi.fn(async (path: string) => {
      const content = mocks.disk.get(path)
      if (content === undefined) throw missing(path)
      return content
    }),
    open: vi.fn(async () => ({ read: async () => 0, close: async () => {} }))
  }
})

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ removeTab: mocks.removeTab }) },
  editorTabId: (filePath: string) => `edit-${filePath}`
}))

vi.mock('@/lib/schedule-git-status-refresh', () => ({
  scheduleGitStatusRefreshForPath: vi.fn()
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

const path = '/test/notes.md'

function at(event: WatchEvent, ...paths: string[]): WatchEvent {
  return { ...event, paths }
}

function seedOpenFile(content: string, unsavedEdit?: string): void {
  const fileState: EditorFileState = {
    filePath: path,
    content: unsavedEdit ?? content,
    kind: 'text',
    originalContent: content,
    isDirty: unsavedEdit !== undefined,
    language: 'markdown',
    lastModified: 0,
    viewMode: 'code',
    cursorPosition: { line: 1, col: 1 },
    scrollTop: 0,
    operationStatus: 'idle'
  }
  useEditorStore.setState({ openFiles: new Map([[path, fileState]]), activeFilePath: path })
}

function WatcherHost(): null {
  useFileWatcher()
  return null
}

async function settle(): Promise<void> {
  await vi.waitFor(() => {
    expect(useEditorStore.getState().openFiles.get(path)?.operationStatus ?? 'idle').toBe('idle')
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('desktop watcher events reaching an open editor tab', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.disk.clear()
    mocks.disk.set(path, 'before')
    seedOpenFile('before')
    render(createElement(WatcherHost))
    await filesystemApi.watchDirectory('/test')
  })

  afterEach(() => {
    _resetFilesystemStateForTesting()
    useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
  })

  it('closes the tab when the open file is deleted', async () => {
    mocks.disk.delete(path)
    mocks.emit?.(at(notifyWatchEvents.removeFile, path))
    await settle()

    expect(useEditorStore.getState().openFiles.has(path)).toBe(false)
    expect(mocks.removeTab).toHaveBeenCalledWith(`edit-${path}`)
  })

  it('keeps the unsaved edits and says the file is gone when the file of a dirty tab is deleted', async () => {
    seedOpenFile('before', 'before plus unsaved edits')
    mocks.disk.delete(path)
    mocks.emit?.(at(notifyWatchEvents.removeFile, path))
    await settle()

    const file = useEditorStore.getState().openFiles.get(path)
    expect(file?.content).toBe('before plus unsaved edits')
    expect(file?.isDirty).toBe(true)
    expect(mocks.removeTab).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(
      'File deleted on disk',
      expect.objectContaining({ description: 'notes.md (unsaved edits kept)' })
    )
  })

  it('keeps the unsaved edits when a tool moves the file of a dirty tab away (mv)', async () => {
    seedOpenFile('before', 'before plus unsaved edits')
    mocks.disk.delete(path)
    mocks.emit?.(at(notifyWatchEvents.renameFrom, path))
    mocks.emit?.(at(notifyWatchEvents.renameTo, '/test/moved.md'))
    await settle()

    expect(useEditorStore.getState().openFiles.get(path)?.content).toBe('before plus unsaved edits')
    expect(mocks.removeTab).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('File deleted on disk', expect.anything())
  })

  it('keeps and reloads the tab when git removes and rewrites the file (checkout, stash)', async () => {
    mocks.disk.set(path, 'after')
    mocks.emit?.(at(notifyWatchEvents.removeFile, path))
    mocks.emit?.(at(notifyWatchEvents.createFile, path))
    mocks.emit?.(at(notifyWatchEvents.modifyData, path))
    await settle()

    expect(useEditorStore.getState().openFiles.get(path)?.content).toBe('after')
    expect(mocks.removeTab).not.toHaveBeenCalled()
  })

  it('reloads the tab when a tool replaces the file by renaming a temp file over it (sed -i)', async () => {
    mocks.disk.set(path, 'after')
    mocks.emit?.(at(notifyWatchEvents.renameFrom, '/test/sedTmp'))
    mocks.emit?.(at(notifyWatchEvents.renameTo, path))
    mocks.emit?.(at(notifyWatchEvents.renameBoth, '/test/sedTmp', path))
    await settle()

    expect(useEditorStore.getState().openFiles.get(path)?.content).toBe('after')
    expect(mocks.removeTab).not.toHaveBeenCalled()
  })

  it('keeps the tab when an editor moves the file aside and writes a new one (vim backup)', async () => {
    mocks.disk.set(path, 'after')
    mocks.emit?.(at(notifyWatchEvents.renameFrom, path))
    mocks.emit?.(at(notifyWatchEvents.renameTo, `${path}~`))
    mocks.emit?.(at(notifyWatchEvents.renameBoth, path, `${path}~`))
    mocks.emit?.(at(notifyWatchEvents.createFile, path))
    mocks.emit?.(at(notifyWatchEvents.modifyData, path))
    mocks.emit?.(at(notifyWatchEvents.removeFile, `${path}~`))
    await settle()

    expect(useEditorStore.getState().openFiles.get(path)?.content).toBe('after')
    expect(mocks.removeTab).not.toHaveBeenCalled()
  })
})
