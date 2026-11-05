import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelAllAutoSaves } from '@/lib/editor-auto-save'
import { type EditorFileState, useEditorStore } from '@/stores/editor-store'
import { editorTabId, useWorkspaceStore } from '@/stores/workspace-store'
import { getAllLeafPanes } from '@/stores/workspace-store/tree'
import { useExplorerEntryFlows } from './use-explorer-entry-flows'

const { mockRenameFile, mockWriteFile } = vi.hoisted(() => ({
  mockRenameFile: vi.fn(),
  mockWriteFile: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    renameFile: mockRenameFile,
    writeFile: mockWriteFile,
    readFile: vi.fn(),
    createFile: vi.fn(),
    createDirectory: vi.fn(),
    deletePath: vi.fn(),
    unwatchDirectory: vi.fn()
  }
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/schedule-git-status-refresh', () => ({ scheduleGitStatusRefreshForPath: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn() }) }))

vi.mock('@/stores/file-explorer-store', () => ({
  useFileExplorerActions: () => ({
    toggleDirectory: vi.fn(),
    selectPath: vi.fn(),
    refreshDirectory: vi.fn().mockResolvedValue(undefined)
  }),
  useFileExplorerStore: { getState: vi.fn(() => ({})), setState: vi.fn() }
}))

function openFile(filePath: string, content: string, originalContent: string): void {
  const file: EditorFileState = {
    kind: 'text',
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

async function renameInExplorer(entry: DirectoryEntry, newName: string): Promise<void> {
  const { result } = renderHook(() =>
    useExplorerEntryFlows({
      rootPath: '/project',
      selectedPaths: new Set(),
      directoryContents: new Map(),
      containerRef: { current: null }
    })
  )
  act(() => result.current.startRename(entry))
  act(() => result.current.inlineInputContext.setValue(newName))
  await act(async () => {
    result.current.inlineInputContext.onSubmit()
  })
  await waitFor(() => expect(result.current.inlineInput).toBeNull())
}

describe('renaming an open file in the explorer', () => {
  beforeEach(() => {
    mockRenameFile.mockReset().mockResolvedValue({ success: true, data: undefined })
    mockWriteFile.mockReset().mockResolvedValue({ success: true, data: undefined })
    useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
    useWorkspaceStore.setState({
      root: { type: 'leaf', id: 'pane-root', tabs: [], activeTabId: null },
      activePaneId: 'pane-root'
    })
  })

  afterEach(() => {
    cancelAllAutoSaves()
  })

  it('keeps unsaved edits at the new path and saves them there', async () => {
    openFile('/project/src/a.ts', 'unsaved edit', 'on disk')

    await renameInExplorer({ path: '/project/src/a.ts', name: 'a.ts', type: 'file' }, 'renamed.ts')

    expect(mockRenameFile).toHaveBeenCalledWith('/project/src/a.ts', '/project/src/renamed.ts')
    const { openFiles, activeFilePath } = useEditorStore.getState()
    expect([...openFiles.keys()]).toEqual(['/project/src/renamed.ts'])
    expect(activeFilePath).toBe('/project/src/renamed.ts')
    expect(openFiles.get('/project/src/renamed.ts')).toMatchObject({
      filePath: '/project/src/renamed.ts',
      content: 'unsaved edit',
      originalContent: 'on disk',
      isDirty: true,
      cursorPosition: { line: 3, col: 7 },
      scrollTop: 40
    })
    expect(editorTabIds()).toEqual([editorTabId('/project/src/renamed.ts')])

    await expect(useEditorStore.getState().saveFile('/project/src/renamed.ts')).resolves.toBe(true)
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(mockWriteFile).toHaveBeenCalledWith('/project/src/renamed.ts', 'unsaved edit')
  })

  it('moves every open file under a renamed folder and keeps their edits', async () => {
    openFile('/project/src/a.ts', 'edited a', 'disk a')
    openFile('/project/src/deep/c.ts', 'c', 'c')
    openFile('/project/other/d.ts', 'd', 'd')

    await renameInExplorer({ path: '/project/src', name: 'src', type: 'directory' }, 'lib')

    expect(mockRenameFile).toHaveBeenCalledWith('/project/src', '/project/lib')
    const { openFiles } = useEditorStore.getState()
    expect([...openFiles.keys()]).toEqual([
      '/project/lib/a.ts',
      '/project/lib/deep/c.ts',
      '/project/other/d.ts'
    ])
    expect(openFiles.get('/project/lib/a.ts')).toMatchObject({
      content: 'edited a',
      originalContent: 'disk a',
      isDirty: true
    })
    expect(openFiles.get('/project/lib/deep/c.ts')?.isDirty).toBe(false)
    expect(editorTabIds()).toEqual([
      editorTabId('/project/lib/a.ts'),
      editorTabId('/project/lib/deep/c.ts'),
      editorTabId('/project/other/d.ts')
    ])
  })

  it('leaves the open file alone when the rename fails', async () => {
    mockRenameFile.mockResolvedValue({ success: false, error: 'exists' })
    openFile('/project/src/a.ts', 'unsaved edit', 'on disk')

    const { result } = renderHook(() =>
      useExplorerEntryFlows({
        rootPath: '/project',
        selectedPaths: new Set(),
        directoryContents: new Map(),
        containerRef: { current: null }
      })
    )
    act(() => result.current.startRename({ path: '/project/src/a.ts', name: 'a.ts', type: 'file' }))
    act(() => result.current.inlineInputContext.setValue('b.ts'))
    await act(async () => {
      result.current.inlineInputContext.onSubmit()
    })
    await waitFor(() => expect(mockRenameFile).toHaveBeenCalled())

    expect([...useEditorStore.getState().openFiles.keys()]).toEqual(['/project/src/a.ts'])
    expect(editorTabIds()).toEqual([editorTabId('/project/src/a.ts')])
  })
})
