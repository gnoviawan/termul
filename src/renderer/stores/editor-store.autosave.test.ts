import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { useAppSettingsStore } from './app-settings-store'
import { useEditorStore } from './editor-store'

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    readFile: vi.fn(),
    writeFile: vi.fn()
  }
}))

vi.mock('@/lib/editor-content-flush', () => ({
  flushEditorContent: vi.fn()
}))

import { filesystemApi } from '@/lib/api'
import { cancelAllAutoSaves } from '@/lib/editor-auto-save'
import { flushEditorContent } from '@/lib/editor-content-flush'

const path = '/project/file.ts'

function seedOpenFile(): void {
  useEditorStore.setState({
    openFiles: new Map([
      [
        path,
        {
          filePath: path,
          content: 'original',
          originalContent: 'original',
          isDirty: false,
          language: 'typescript',
          lastModified: 0,
          viewMode: 'code',
          cursorPosition: { line: 1, col: 1 },
          scrollTop: 0,
          operationStatus: 'idle'
        }
      ]
    ]),
    activeFilePath: path
  })
}

function setAutoSave(enabled: boolean, delayMs = 500): void {
  useAppSettingsStore.setState({
    settings: { ...DEFAULT_APP_SETTINGS, editorAutoSave: enabled, editorAutoSaveDelayMs: delayMs },
    isLoaded: true
  })
}

describe('editor-store auto-save wiring (GH-539)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(flushEditorContent).mockReset()
    vi.mocked(flushEditorContent).mockResolvedValue(undefined)
    vi.mocked(filesystemApi.writeFile).mockReset()
    vi.mocked(filesystemApi.writeFile).mockResolvedValue({ success: true, data: undefined })
    seedOpenFile()
  })

  afterEach(() => {
    cancelAllAutoSaves()
    useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
    setAutoSave(false)
    vi.useRealTimers()
  })

  it('saves automatically after edits pause for the configured delay', async () => {
    setAutoSave(true, 500)

    useEditorStore.getState().updateContent(path, 'edited')
    expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(true)

    await vi.advanceTimersByTimeAsync(499)
    expect(filesystemApi.writeFile).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(filesystemApi.writeFile).toHaveBeenCalledTimes(1)
    expect(filesystemApi.writeFile).toHaveBeenCalledWith(path, 'edited')
    expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(false)
  })

  it('does not auto-save when the setting is disabled', async () => {
    setAutoSave(false)

    useEditorStore.getState().updateContent(path, 'edited')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(filesystemApi.writeFile).not.toHaveBeenCalled()
    expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(true)
  })

  it('cancels the pending save when the buffer returns to the original content', async () => {
    setAutoSave(true, 500)

    useEditorStore.getState().updateContent(path, 'edited')
    useEditorStore.getState().updateContent(path, 'original')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(filesystemApi.writeFile).not.toHaveBeenCalled()
  })

  it('cancels the pending save when the file is closed before the delay elapses', async () => {
    setAutoSave(true, 500)

    useEditorStore.getState().updateContent(path, 'edited')
    useEditorStore.getState().closeFile(path)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(filesystemApi.writeFile).not.toHaveBeenCalled()
  })

  it('keeps the manual save path intact (saveFile still honors dirty state)', async () => {
    setAutoSave(true, 500)
    useEditorStore.getState().updateContent(path, 'edited')

    const saved = await useEditorStore.getState().saveFile(path)

    expect(saved).toBe(true)
    expect(filesystemApi.writeFile).toHaveBeenCalledWith(path, 'edited')
  })
})
