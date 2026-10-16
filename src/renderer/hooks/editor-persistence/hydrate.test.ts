import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRead, mockReadFile } = vi.hoisted(() => ({
  mockRead: vi.fn(),
  mockReadFile: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: { read: mockRead },
  filesystemApi: { readFile: mockReadFile }
}))
vi.mock('@/hooks/useTerminalAutoSave', () => ({ loadPersistedTerminals: vi.fn(async () => null) }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { useEditorStore } from '@/stores/editor-store'
import { hydrateProject } from './hydrate'

function persistedFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filePath: '/p/a.ts',
    cursorPosition: { line: 4, col: 2 },
    scrollTop: 30,
    viewMode: 'code',
    isDirty: true,
    draftContent: 'draft text',
    lastModified: 100,
    ...overrides
  }
}

function persistedState(file: Record<string, unknown>): { success: true; data: unknown } {
  return {
    success: true,
    data: { openFiles: [file], activeFilePath: '/p/a.ts', expandedDirs: [], activeTabId: null }
  }
}

describe('hydrateProject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stages files off-store: a draft not older than disk is applied and view state restored', async () => {
    mockRead.mockResolvedValue(persistedState(persistedFile()))
    mockReadFile.mockResolvedValue({ success: true, data: { content: 'disk', modifiedAt: 100 } })
    const openFilesBefore = useEditorStore.getState().openFiles

    const staged = await hydrateProject('p1', () => true)

    const file = staged.editorFiles.get('/p/a.ts')
    expect(file).toMatchObject({
      content: 'draft text',
      originalContent: 'disk',
      isDirty: true,
      cursorPosition: { line: 4, col: 2 },
      scrollTop: 30
    })
    expect(staged.activeFilePath).toBe('/p/a.ts')
    expect(staged.tree).not.toBeNull()
    // Nothing was written to the editor store.
    expect(useEditorStore.getState().openFiles).toBe(openFilesBefore)
  })

  it('shows a conflict, not a dropped draft, when the file changed after the draft was taken', async () => {
    mockRead.mockResolvedValue(persistedState(persistedFile()))
    mockReadFile.mockResolvedValue({ success: true, data: { content: 'disk', modifiedAt: 101 } })

    const staged = await hydrateProject('p1', () => true)

    expect(staged.editorFiles.get('/p/a.ts')).toMatchObject({
      content: 'disk',
      isDirty: false,
      draftConflict: { draftContent: 'draft text', draftSavedAt: 100 }
    })
  })

  it('skips files that can no longer be read', async () => {
    mockRead.mockResolvedValue(persistedState(persistedFile()))
    mockReadFile.mockResolvedValue({ success: false, error: 'gone' })

    const staged = await hydrateProject('p1', () => true)

    expect(staged.editorFiles.size).toBe(0)
  })

  it('withTree:false stages editor state only and no tree', async () => {
    mockRead.mockResolvedValue(persistedState(persistedFile()))
    mockReadFile.mockResolvedValue({ success: true, data: { content: 'disk', modifiedAt: 1 } })

    const staged = await hydrateProject('p1', () => true, { withTree: false })

    expect(staged.tree).toBeNull()
    expect(staged.editorFiles.size).toBe(1)
  })

  it('stops reading once it is no longer current', async () => {
    mockRead.mockResolvedValue(persistedState(persistedFile()))

    await hydrateProject('p1', () => false)

    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('stages a fresh workspace when nothing is stored for the project on this device', async () => {
    mockRead.mockResolvedValue({ success: true, data: null })

    const staged = await hydrateProject('p1', () => true)

    expect(staged.editorFiles.size).toBe(0)
    expect(staged.tree?.root).toMatchObject({ type: 'leaf', tabs: [] })
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('restores a saved split layout with its pane sizes and active pane', async () => {
    const openFile = (filePath: string, viewMode: string): Record<string, unknown> =>
      persistedFile({ filePath, viewMode, isDirty: false, draftContent: undefined })
    mockRead.mockResolvedValue({
      success: true,
      data: {
        openFiles: [openFile('/w/a.ts', 'code'), openFile('/w/README.md', 'markdown')],
        activeFilePath: '/w/README.md',
        expandedDirs: [],
        activeTabId: 'edit-/w/README.md',
        paneLayout: {
          type: 'split',
          id: 's1',
          direction: 'horizontal',
          children: [
            {
              type: 'leaf',
              id: 'l1',
              tabs: [
                { type: 'terminal', terminalId: 't1' },
                { type: 'editor', filePath: '/w/a.ts' }
              ],
              activeTabId: 'edit-/w/a.ts'
            },
            {
              type: 'leaf',
              id: 'l2',
              tabs: [{ type: 'editor', filePath: '/w/README.md' }],
              activeTabId: 'edit-/w/README.md'
            }
          ],
          sizes: [60, 40]
        },
        activePaneId: 'l2'
      }
    })
    mockReadFile.mockResolvedValue({ success: true, data: { content: 'disk', modifiedAt: 1 } })

    const staged = await hydrateProject('p1', () => true)

    expect([...staged.editorFiles.keys()]).toEqual(['/w/a.ts', '/w/README.md'])
    expect(staged.activeFilePath).toBe('/w/README.md')
    expect(staged.tree?.activePaneId).toBe('l2')
    const root = staged.tree?.root
    if (root?.type !== 'split') throw new Error('expected the saved split')
    expect(root.sizes).toEqual([60, 40])
    // The terminal of another device is not live here, so its tab is dropped.
    expect(
      root.children.map((pane) => (pane.type === 'leaf' ? pane.tabs.map((t) => t.id) : []))
    ).toEqual([['edit-/w/a.ts'], ['edit-/w/README.md']])
  })
})
