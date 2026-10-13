import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockWriteDebounced } = vi.hoisted(() => ({ mockWriteDebounced: vi.fn() }))

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return { ...actual, persistenceApi: { read: vi.fn(), writeDebounced: mockWriteDebounced } }
})
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { emptyStagedProject } from '@/lib/project-switch/types'
import { type EditorFileState, useEditorStore } from '@/stores/editor-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { commitStagedProject } from './commit'

function file(filePath: string, content: string, isDirty: boolean): EditorFileState {
  return {
    filePath,
    content,
    originalContent: 'disk',
    isDirty,
    language: '',
    lastModified: 1,
    viewMode: 'code',
    cursorPosition: { line: 1, col: 1 },
    scrollTop: 0,
    operationStatus: 'idle'
  }
}

describe('commitStagedProject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
    useWorkspaceStore.setState({ activeProjectId: 'old', parkedTrees: {} })
  })

  it('persists edits made in the hydration window under the project being left before clearing the buffers', () => {
    // `leave()` persisted `old` earlier; the user kept typing while the target hydrated.
    useEditorStore.setState({
      openFiles: new Map([['/old/a.ts', file('/old/a.ts', 'typed during hydration', true)]]),
      activeFilePath: '/old/a.ts'
    })

    commitStagedProject('new', emptyStagedProject())

    expect(mockWriteDebounced).toHaveBeenCalledTimes(1)
    const [key, data] = mockWriteDebounced.mock.calls[0]
    expect(key).toBe('workspace/old')
    expect(data.openFiles).toEqual([
      expect.objectContaining({
        filePath: '/old/a.ts',
        isDirty: true,
        draftContent: 'typed during hydration'
      })
    ])
    // The swap still happened.
    expect(useEditorStore.getState().openFiles.size).toBe(0)
    expect(useWorkspaceStore.getState().activeProjectId).toBe('new')
  })

  it('persists nothing on the first commit (no project was visible)', () => {
    useWorkspaceStore.setState({ activeProjectId: '' })

    commitStagedProject('new', emptyStagedProject())

    expect(mockWriteDebounced).not.toHaveBeenCalled()
  })
})
