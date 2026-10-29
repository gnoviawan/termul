import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openFiles: new Map<string, { draftConflict?: unknown }>(),
  toastWarning: vi.fn(),
  setActivePane: vi.fn(),
  setActiveTab: vi.fn(),
  clearFullscreenPane: vi.fn(),
  fullscreenPaneId: null as string | null,
  root: {
    type: 'leaf' as const,
    id: 'pane-1',
    tabs: [{ type: 'editor' as const, id: 'edit-/a.ts', filePath: '/a.ts' }],
    activeTabId: null as string | null
  }
}))

vi.mock('sonner', () => ({ toast: { warning: mocks.toastWarning } }))
vi.mock('@/stores/editor-store', () => ({
  useEditorStore: { getState: () => ({ openFiles: mocks.openFiles }) }
}))
vi.mock('@/stores/workspace-store', async () => {
  const actual = await vi.importActual<typeof import('@/stores/workspace-store')>(
    '@/stores/workspace-store'
  )
  return {
    ...actual,
    useWorkspaceStore: {
      getState: () => ({
        root: mocks.root,
        setActivePane: mocks.setActivePane,
        setActiveTab: mocks.setActiveTab,
        clearFullscreenPane: mocks.clearFullscreenPane,
        fullscreenPaneId: mocks.fullscreenPaneId
      })
    }
  }
})

import { blockSaveOnDraftConflict } from './draft-conflict-save-guard'

beforeEach(() => {
  mocks.openFiles = new Map()
  mocks.toastWarning.mockReset()
  mocks.setActivePane.mockReset()
  mocks.setActiveTab.mockReset()
  mocks.clearFullscreenPane.mockReset()
  mocks.fullscreenPaneId = null
})

describe('blockSaveOnDraftConflict', () => {
  it('lets the save proceed when no file has a conflict', () => {
    mocks.openFiles.set('/a.ts', {})

    expect(blockSaveOnDraftConflict(['/a.ts'])).toBe(false)
    expect(mocks.toastWarning).not.toHaveBeenCalled()
    expect(mocks.setActiveTab).not.toHaveBeenCalled()
  })

  it('reveals the conflicted file tab and tells the user to resolve it first', () => {
    mocks.openFiles.set('/a.ts', { kind: 'text', draftConflict: { draftContent: 'd', draftSavedAt: 1 } })

    expect(blockSaveOnDraftConflict(['/a.ts'])).toBe(true)
    expect(mocks.setActivePane).toHaveBeenCalledWith('pane-1')
    expect(mocks.setActiveTab).toHaveBeenCalledWith('pane-1', 'edit-/a.ts')
    expect(mocks.toastWarning).toHaveBeenCalledWith('Resolve the draft conflict first')
  })

  it('blocks a multi-file save when any one file is conflicted', () => {
    mocks.openFiles.set('/clean.ts', {})
    mocks.openFiles.set('/a.ts', { kind: 'text', draftConflict: { draftContent: 'd', draftSavedAt: 1 } })

    expect(blockSaveOnDraftConflict(new Set(['/clean.ts', '/a.ts']))).toBe(true)
    expect(mocks.setActiveTab).toHaveBeenCalledWith('pane-1', 'edit-/a.ts')
  })

  it('leaves fullscreen when the conflicted tab lives in a different pane', () => {
    mocks.fullscreenPaneId = 'pane-other'
    mocks.openFiles.set('/a.ts', { kind: 'text', draftConflict: { draftContent: 'd', draftSavedAt: 1 } })

    blockSaveOnDraftConflict(['/a.ts'])

    expect(mocks.clearFullscreenPane).toHaveBeenCalledTimes(1)
    expect(mocks.setActiveTab).toHaveBeenCalledWith('pane-1', 'edit-/a.ts')
  })

  it('keeps fullscreen when the conflicted tab is in the fullscreen pane', () => {
    mocks.fullscreenPaneId = 'pane-1'
    mocks.openFiles.set('/a.ts', { kind: 'text', draftConflict: { draftContent: 'd', draftSavedAt: 1 } })

    blockSaveOnDraftConflict(['/a.ts'])

    expect(mocks.clearFullscreenPane).not.toHaveBeenCalled()
  })
})
