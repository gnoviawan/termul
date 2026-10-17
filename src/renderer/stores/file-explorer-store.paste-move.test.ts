import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    renameFile: vi.fn(),
    copyFile: vi.fn(),
    writeFile: vi.fn(),
    getFileInfo: vi.fn(),
    readDirectory: vi.fn(),
    createDirectory: vi.fn()
  }
}))

vi.mock('@/lib/api', () => ({ filesystemApi: mockApi }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { cancelAllAutoSaves } from '@/lib/editor-auto-save'
import { logFrontendError } from '@/lib/log-api'
import { type EditorFileState, useEditorStore } from '@/stores/editor-store'
import { editorTabId, useWorkspaceStore } from '@/stores/workspace-store'
import { getAllLeafPanes } from '@/stores/workspace-store/tree'
import { useFileExplorerStore } from './file-explorer-store'

function openFile(filePath: string, content: string, originalContent: string): void {
  const file: EditorFileState = {
    filePath,
    content,
    originalContent,
    isDirty: content !== originalContent,
    language: 'typescript',
    lastModified: 1,
    viewMode: 'code',
    cursorPosition: { line: 3, col: 7 },
    scrollTop: 40,
    operationStatus: 'idle'
  }
  const files = new Map(useEditorStore.getState().openFiles)
  files.set(filePath, file)
  useEditorStore.setState({ openFiles: files, activeFilePath: filePath })
  useWorkspaceStore.getState().addEditorTab(filePath)
}

function editorTabIds(): string[] {
  return getAllLeafPanes(useWorkspaceStore.getState().root)
    .flatMap((leaf) => leaf.tabs)
    .filter((tab) => tab.type === 'editor')
    .map((tab) => tab.id)
}

async function cutAndPaste(paths: string[], destination: string): Promise<void> {
  useFileExplorerStore.setState({ clipboard: { type: 'cut', paths } })
  await useFileExplorerStore.getState().paste(destination)
}

describe('moving an open file with cut and paste', () => {
  beforeEach(() => {
    mockApi.renameFile.mockReset().mockResolvedValue({ success: true, data: undefined })
    mockApi.copyFile.mockReset().mockResolvedValue({ success: true, data: undefined })
    mockApi.writeFile.mockReset().mockResolvedValue({ success: true, data: undefined })
    mockApi.getFileInfo
      .mockReset()
      .mockResolvedValue({ success: true, data: { type: 'directory' } })
    mockApi.readDirectory.mockReset().mockResolvedValue({ success: true, data: [] })
    useFileExplorerStore.setState({ clipboard: null })
    useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
    useWorkspaceStore.setState({
      root: { type: 'leaf', id: 'pane-root', tabs: [], activeTabId: null },
      activePaneId: 'pane-root'
    })
  })

  afterEach(() => {
    cancelAllAutoSaves()
  })

  it('moves the tab and the unsaved buffer to the new path and saves there', async () => {
    openFile('/project/src/a.ts', 'unsaved edit', 'on disk')

    await cutAndPaste(['/project/src/a.ts'], '/project/lib')

    expect(mockApi.renameFile).toHaveBeenCalledWith('/project/src/a.ts', '/project/lib/a.ts')
    const { openFiles, activeFilePath } = useEditorStore.getState()
    expect([...openFiles.keys()]).toEqual(['/project/lib/a.ts'])
    expect(activeFilePath).toBe('/project/lib/a.ts')
    expect(openFiles.get('/project/lib/a.ts')).toMatchObject({
      content: 'unsaved edit',
      originalContent: 'on disk',
      isDirty: true
    })
    expect(editorTabIds()).toEqual([editorTabId('/project/lib/a.ts')])

    await expect(useEditorStore.getState().saveFile('/project/lib/a.ts')).resolves.toBe(true)
    expect(mockApi.writeFile).toHaveBeenCalledTimes(1)
    expect(mockApi.writeFile).toHaveBeenCalledWith('/project/lib/a.ts', 'unsaved edit')
  })

  it('moves every open file under a moved folder', async () => {
    openFile('/project/src/a.ts', 'edited a', 'disk a')
    openFile('/project/src/deep/c.ts', 'c', 'c')
    openFile('/project/other/d.ts', 'd', 'd')

    await cutAndPaste(['/project/src'], '/project/lib')

    expect(mockApi.renameFile).toHaveBeenCalledWith('/project/src', '/project/lib/src')
    expect([...useEditorStore.getState().openFiles.keys()]).toEqual([
      '/project/lib/src/a.ts',
      '/project/lib/src/deep/c.ts',
      '/project/other/d.ts'
    ])
    expect(useEditorStore.getState().openFiles.get('/project/lib/src/a.ts')).toMatchObject({
      content: 'edited a',
      isDirty: true
    })
    expect(editorTabIds()).toEqual([
      editorTabId('/project/lib/src/a.ts'),
      editorTabId('/project/lib/src/deep/c.ts'),
      editorTabId('/project/other/d.ts')
    ])
  })

  it('leaves the open file alone when the move fails and boundary-logs it', async () => {
    mockApi.renameFile.mockResolvedValue({ success: false, error: 'exists' })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(logFrontendError).mockClear()
    openFile('/project/src/a.ts', 'unsaved edit', 'on disk')

    await cutAndPaste(['/project/src/a.ts'], '/project/lib')

    expect([...useEditorStore.getState().openFiles.keys()]).toEqual(['/project/src/a.ts'])
    expect(editorTabIds()).toEqual([editorTabId('/project/src/a.ts')])
    // Per AGENTS.md the failure routes through logFrontendError, not console.
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'file-explorer-store.paste' })
    )
    expect(consoleSpy).not.toHaveBeenCalledWith('Failed to move:', expect.anything())
  })

  describe('racing a save', () => {
    const ok = { success: true, data: undefined }
    let disk: Map<string, string>

    function held(): { promise: Promise<void>; release: () => void } {
      let release = (): void => {}
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      return { promise, release }
    }

    function moveOnDisk(from: string, to: string): void {
      disk.set(to, disk.get(from) ?? '')
      disk.delete(from)
    }

    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

    beforeEach(() => {
      disk = new Map([['/project/src/a.ts', 'on disk']])
      mockApi.renameFile.mockImplementation(async (from: string, to: string) => {
        moveOnDisk(from, to)
        return ok
      })
      mockApi.writeFile.mockImplementation(async (path: string, content: string) => {
        disk.set(path, content)
        return ok
      })
    })

    it('moves the file after the save in flight lands, leaving one file with the saved content', async () => {
      const write = held()
      mockApi.writeFile.mockImplementation(async (path: string, content: string) => {
        await write.promise
        disk.set(path, content)
        return ok
      })
      openFile('/project/src/a.ts', 'saved edit', 'on disk')

      const save = useEditorStore.getState().saveFile('/project/src/a.ts')
      await settle()
      expect(mockApi.writeFile).toHaveBeenCalledWith('/project/src/a.ts', 'saved edit')
      const move = cutAndPaste(['/project/src/a.ts'], '/project/lib')
      await settle()
      write.release()
      await Promise.all([save, move])

      expect([...disk]).toEqual([['/project/lib/a.ts', 'saved edit']])
      expect(useEditorStore.getState().openFiles.get('/project/lib/a.ts')).toMatchObject({
        content: 'saved edit',
        isDirty: false
      })
    })

    it('saves at the new path when the save is requested while the move is in flight', async () => {
      const reply = held()
      mockApi.renameFile.mockImplementation(async (from: string, to: string) => {
        moveOnDisk(from, to)
        await reply.promise
        return ok
      })
      openFile('/project/src/a.ts', 'saved edit', 'on disk')

      const move = cutAndPaste(['/project/src/a.ts'], '/project/lib')
      await settle()
      expect(mockApi.renameFile).toHaveBeenCalledWith('/project/src/a.ts', '/project/lib/a.ts')
      const save = useEditorStore.getState().saveFile('/project/src/a.ts')
      await settle()
      reply.release()

      await expect(save).resolves.toBe(true)
      await move
      expect([...disk]).toEqual([['/project/lib/a.ts', 'saved edit']])
      expect(mockApi.writeFile).toHaveBeenCalledTimes(1)
      expect(mockApi.writeFile).toHaveBeenCalledWith('/project/lib/a.ts', 'saved edit')
    })

    it('moves a file opened under the folder while the move is in flight, and saves it at the new path', async () => {
      disk.set('/project/src/b.ts', 'b on disk')
      const reply = held()
      mockApi.renameFile.mockImplementation(async (from: string, to: string) => {
        for (const path of [...disk.keys()]) {
          if (path.startsWith(`${from}/`)) moveOnDisk(path, `${to}${path.slice(from.length)}`)
        }
        await reply.promise
        return ok
      })
      openFile('/project/src/a.ts', 'a on disk', 'a on disk')

      const move = cutAndPaste(['/project/src'], '/project/lib')
      await settle()
      expect(mockApi.renameFile).toHaveBeenCalledWith('/project/src', '/project/lib/src')
      openFile('/project/src/b.ts', 'b edit', 'b on disk')
      const save = useEditorStore.getState().saveFile('/project/src/b.ts')
      await settle()
      reply.release()
      await Promise.all([save, move])

      expect(editorTabIds().sort()).toEqual([
        editorTabId('/project/lib/src/a.ts'),
        editorTabId('/project/lib/src/b.ts')
      ])
      expect([...disk.keys()].sort()).toEqual(['/project/lib/src/a.ts', '/project/lib/src/b.ts'])
      expect(disk.get('/project/lib/src/b.ts')).toBe('b edit')
    })
  })

  it('keeps the open file where it is when copying', async () => {
    openFile('/project/src/a.ts', 'unsaved edit', 'on disk')
    useFileExplorerStore.setState({ clipboard: { type: 'copy', paths: ['/project/src/a.ts'] } })

    await useFileExplorerStore.getState().paste('/project/lib')

    expect(mockApi.copyFile).toHaveBeenCalledWith('/project/src/a.ts', '/project/lib/a.ts')
    expect([...useEditorStore.getState().openFiles.keys()]).toEqual(['/project/src/a.ts'])
  })
})
