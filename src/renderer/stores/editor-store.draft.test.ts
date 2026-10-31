import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { useAppSettingsStore } from './app-settings-store'
import { type EditorFileState, reconcileDraft, useEditorStore } from './editor-store'

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    readFile: vi.fn(),
    writeFile: vi.fn()
  }
}))

vi.mock('@/lib/editor-content-flush', () => ({
  flushEditorContent: vi.fn()
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn().mockResolvedValue(undefined)
}))

import { filesystemApi } from '@/lib/api'
import { cancelAllAutoSaves, getPendingAutoSaveCount } from '@/lib/editor-auto-save'
import { flushEditorContent } from '@/lib/editor-content-flush'
import { logFrontendError } from '@/lib/log-api'

const path = '/project/file.ts'

function makeFile(overrides: Partial<EditorFileState> = {}): EditorFileState {
  return {
    filePath: path,
    content: 'disk',
    kind: 'text',
    originalContent: 'disk',
    isDirty: false,
    language: 'typescript',
    lastModified: 1_000,
    viewMode: 'code',
    cursorPosition: { line: 1, col: 1 },
    scrollTop: 0,
    operationStatus: 'idle',
    ...overrides
  }
}

function seed(file: EditorFileState): void {
  useEditorStore.setState({ openFiles: new Map([[path, file]]), activeFilePath: path })
}

function current(): EditorFileState | undefined {
  return useEditorStore.getState().openFiles.get(path)
}

describe('reconcileDraft', () => {
  it('leaves the file untouched when the draft equals the disk content', () => {
    const file = makeFile({ lastModified: 5_000 })
    expect(reconcileDraft(file, { content: 'disk', savedAt: 1 })).toBe(file)
  })

  it('applies the draft as an unsaved edit when disk is not newer than the draft', () => {
    const file = makeFile({ lastModified: 1_000 })
    const next = reconcileDraft(file, { content: 'draft', savedAt: 1_000 })
    expect(next).toMatchObject({ content: 'draft', originalContent: 'disk', isDirty: true })
    expect(next.draftConflict).toBeUndefined()
  })

  it('records a conflict and keeps the disk content when disk is newer than the draft', () => {
    const file = makeFile({ lastModified: 2_000 })
    const next = reconcileDraft(file, { content: 'draft', savedAt: 1_999 })
    expect(next).toMatchObject({ content: 'disk', isDirty: false })
    expect(next.draftConflict).toEqual({ draftContent: 'draft', draftSavedAt: 1_999 })
  })

  it('does not mutate its input', () => {
    const file = makeFile({ lastModified: 2_000 })
    reconcileDraft(file, { content: 'draft', savedAt: 1 })
    expect(file.draftConflict).toBeUndefined()
  })
})

describe('editor-store draft restore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(flushEditorContent).mockReset()
    vi.mocked(logFrontendError).mockClear()
    vi.mocked(flushEditorContent).mockResolvedValue(undefined)
    vi.mocked(filesystemApi.writeFile).mockReset()
    vi.mocked(filesystemApi.writeFile).mockResolvedValue({ success: true, data: undefined })
    vi.mocked(filesystemApi.readFile).mockReset()
    useAppSettingsStore.setState({
      settings: { ...DEFAULT_APP_SETTINGS, editorAutoSave: true, editorAutoSaveDelayMs: 500 },
      isLoaded: true
    })
    seed(makeFile())
  })

  afterEach(() => {
    cancelAllAutoSaves()
    useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
    useAppSettingsStore.setState({
      settings: { ...DEFAULT_APP_SETTINGS, editorAutoSave: false },
      isLoaded: true
    })
    vi.useRealTimers()
  })

  it('restoreDraft applies a draft and schedules auto-save', () => {
    const outcome = useEditorStore
      .getState()
      .restoreDraft(path, { content: 'draft', savedAt: 2_000 })

    expect(outcome).toBe('applied')
    expect(current()).toMatchObject({ content: 'draft', isDirty: true })
    expect(getPendingAutoSaveCount()).toBe(1)
  })

  it('restoreDraft reports a conflict without scheduling auto-save or touching the buffer', () => {
    seed(makeFile({ lastModified: 9_000 }))

    const outcome = useEditorStore
      .getState()
      .restoreDraft(path, { content: 'draft', savedAt: 2_000 })

    expect(outcome).toBe('conflict')
    expect(current()).toMatchObject({
      content: 'disk',
      isDirty: false,
      draftConflict: { draftContent: 'draft', draftSavedAt: 2_000 }
    })
    expect(getPendingAutoSaveCount()).toBe(0)
  })

  it('restoreDraft is a no-op for identical content and for an unknown path', () => {
    expect(useEditorStore.getState().restoreDraft(path, { content: 'disk', savedAt: 9 })).toBe(
      'unchanged'
    )
    expect(useEditorStore.getState().restoreDraft('/nope', { content: 'x', savedAt: 9 })).toBe(
      'unchanged'
    )
    expect(current()).toMatchObject({ content: 'disk', isDirty: false })
    expect(getPendingAutoSaveCount()).toBe(0)
  })

  it("resolveDraftConflict 'draft' applies the draft as a dirty edit, clears the conflict and arms auto-save", () => {
    seed(makeFile({ lastModified: 9_000 }))
    useEditorStore.getState().restoreDraft(path, { content: 'draft', savedAt: 2_000 })

    useEditorStore.getState().resolveDraftConflict(path, 'draft')

    expect(current()).toMatchObject({ content: 'draft', isDirty: true })
    expect(current()?.draftConflict).toBeUndefined()
    expect(getPendingAutoSaveCount()).toBe(1)
  })

  it("resolveDraftConflict 'disk' keeps the disk buffer and clears the conflict", () => {
    seed(makeFile({ lastModified: 9_000 }))
    useEditorStore.getState().restoreDraft(path, { content: 'draft', savedAt: 2_000 })

    useEditorStore.getState().resolveDraftConflict(path, 'disk')

    expect(current()).toMatchObject({ content: 'disk', isDirty: false })
    expect(current()?.draftConflict).toBeUndefined()
    expect(getPendingAutoSaveCount()).toBe(0)
  })

  it('counts a conflicted file as needing attention until it is resolved', () => {
    seed(makeFile({ lastModified: 9_000 }))
    useEditorStore.getState().restoreDraft(path, { content: 'draft', savedAt: 2_000 })

    expect(useEditorStore.getState().hasDirtyFiles()).toBe(true)
    expect(useEditorStore.getState().getDirtyFileCount()).toBe(1)

    useEditorStore.getState().resolveDraftConflict(path, 'disk')

    expect(useEditorStore.getState().hasDirtyFiles()).toBe(false)
    expect(useEditorStore.getState().getDirtyFileCount()).toBe(0)
  })

  it('refuses to save or reload a conflicted file so the draft decision is never buried', async () => {
    seed(makeFile({ lastModified: 9_000 }))
    useEditorStore.getState().restoreDraft(path, { content: 'draft', savedAt: 2_000 })

    expect(await useEditorStore.getState().saveFile(path)).toBe(false)
    await useEditorStore.getState().reloadFile(path)

    expect(filesystemApi.writeFile).not.toHaveBeenCalled()
    expect(filesystemApi.readFile).not.toHaveBeenCalled()
    expect(current()?.draftConflict).toBeDefined()
  })

  it('drops edits made while a conflict is unresolved so no edit lives outside the two buffers', () => {
    seed(makeFile({ lastModified: 9_000 }))
    useEditorStore.getState().restoreDraft(path, { content: 'draft', savedAt: 2_000 })

    useEditorStore.getState().updateContent(path, 'typed during conflict')

    expect(current()).toMatchObject({ content: 'disk', isDirty: false })
    expect(current()?.draftConflict).toEqual({ draftContent: 'draft', draftSavedAt: 2_000 })
    expect(getPendingAutoSaveCount()).toBe(0)
  })

  it('logs only the basename when a save is refused for a conflict', async () => {
    const conflicted = '/secret/dir/file.ts'
    useEditorStore.setState({
      openFiles: new Map([[conflicted, makeFile({ filePath: conflicted, lastModified: 9_000 })]])
    })
    useEditorStore.getState().restoreDraft(conflicted, { content: 'draft', savedAt: 2_000 })

    await useEditorStore.getState().saveFile(conflicted)

    const messages = vi
      .mocked(logFrontendError)
      .mock.calls.map((call) => call[0].message)
      .filter((message) => message.includes('unresolved draft conflict'))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('file.ts')
    expect(messages[0]).not.toContain('/secret')
  })
})
