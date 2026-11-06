import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { useAppSettingsStore } from './app-settings-store'
import { type EditorFileState, useEditorStore } from './editor-store'

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    getFileInfo: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn()
  }
}))

vi.mock('@/lib/editor-content-flush', () => ({
  flushEditorContent: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/schedule-git-status-refresh', () => ({
  scheduleGitStatusRefreshForPath: vi.fn()
}))

import { filesystemApi } from '@/lib/api'
import { cancelAllAutoSaves } from '@/lib/editor-auto-save'

const from = '/project/a.ts'
const to = '/project/b.ts'

function seed(operationStatus: EditorFileState['operationStatus']): void {
  useEditorStore.setState({
    openFiles: new Map([
      [
        from,
        {
          filePath: from,
          content: 'edited',
          kind: 'text',
          originalContent: 'on disk',
          isDirty: true,
          language: 'typescript',
          lastModified: 0,
          viewMode: 'code',
          cursorPosition: { line: 1, col: 1 },
          scrollTop: 0,
          operationStatus
        }
      ]
    ]),
    activeFilePath: from
  })
}

describe('editor-store renameOpenFile', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(filesystemApi.writeFile).mockReset()
    vi.mocked(filesystemApi.writeFile).mockResolvedValue({ success: true, data: undefined })
    useAppSettingsStore.setState({
      settings: { ...DEFAULT_APP_SETTINGS, editorAutoSave: true, editorAutoSaveDelayMs: 500 },
      isLoaded: true
    })
  })

  afterEach(() => {
    cancelAllAutoSaves()
    vi.useRealTimers()
  })

  it('does not carry a save in flight over to the renamed entry, so autosave can save it', async () => {
    seed('saving')

    useEditorStore.getState().renameOpenFile(from, to)

    expect(useEditorStore.getState().openFiles.get(to)).toMatchObject({
      operationStatus: 'idle',
      isDirty: true,
      content: 'edited'
    })

    await vi.advanceTimersByTimeAsync(600)

    expect(filesystemApi.writeFile).toHaveBeenCalledWith(to, 'edited')
    expect(useEditorStore.getState().openFiles.get(to)?.isDirty).toBe(false)
  })
})
