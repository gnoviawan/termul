import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { useAppSettingsStore } from './app-settings-store'
import { useEditorStore } from './editor-store'

// Story 4 (QA r2 P1 "web editor has no working save path"): the QA repro
// matrix. Row 1 (debounce flush), row 3 (autosave off), row 4 (save race),
// row 5 (dirty-check skip) live here at the store level; row 2 (mobile
// button immediate save) lives in EditorToolbar.save.test.tsx.

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    getFileInfo: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn()
  }
}))

vi.mock('@/lib/editor-content-flush', () => ({
  flushEditorContent: vi.fn()
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/schedule-git-status-refresh', () => ({
  scheduleGitStatusRefreshForPath: vi.fn()
}))

import { filesystemApi } from '@/lib/api'
import { cancelAllAutoSaves } from '@/lib/editor-auto-save'
import { flushEditorContent } from '@/lib/editor-content-flush'
import { logFrontendError } from '@/lib/log-api'

const path = '/project/notes.md'

function seedOpenFile(content = 'original'): void {
  useEditorStore.setState({
    openFiles: new Map([
      [
        path,
        {
          filePath: path,
          content,
          originalContent: 'original',
          isDirty: content !== 'original',
          language: 'markdown',
          lastModified: 0,
          viewMode: 'markdown',
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

describe('editor-store saveFile (QA r2 story 4 matrix rows 1/3/4/5)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.mocked(flushEditorContent).mockReset()
    vi.mocked(flushEditorContent).mockResolvedValue(undefined)
    vi.mocked(filesystemApi.writeFile).mockReset()
    vi.mocked(filesystemApi.writeFile).mockResolvedValue({ success: true, data: undefined })
    vi.mocked(logFrontendError).mockReset()
    seedOpenFile()
    setAutoSave(false)
  })

  afterEach(() => {
    cancelAllAutoSaves()
    useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
    setAutoSave(false)
    vi.useRealTimers()
  })

  it('row 1 — autosave debounce flushes to the write API after the delay (QA repro: 0 bytes until Ctrl+S)', async () => {
    setAutoSave(true, 500)

    useEditorStore.getState().updateContent(path, 'typed content')
    expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(true)

    // 0 bytes only before the window: no write before the debounce fires.
    await vi.advanceTimersByTimeAsync(499)
    expect(filesystemApi.writeFile).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(filesystemApi.writeFile).toHaveBeenCalledTimes(1)
    expect(filesystemApi.writeFile).toHaveBeenCalledWith(path, 'typed content')
    expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(false)
  })

  it('row 1 — save failure: dirty stays, failure is boundary-logged, autosave retries next window', async () => {
    setAutoSave(true, 500)
    vi.mocked(filesystemApi.writeFile).mockResolvedValue({
      success: false,
      error: 'disk full',
      code: 'WRITE_ERROR'
    })

    useEditorStore.getState().updateContent(path, 'typed content')
    await vi.advanceTimersByTimeAsync(500)

    expect(filesystemApi.writeFile).toHaveBeenCalledTimes(1)
    expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(true)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        source: 'editor-store.saveFile',
        message: expect.stringContaining('editor save failed')
      })
    )
    // Failure logged with byte length, never content.
    const loggedMessage = vi.mocked(logFrontendError).mock.calls[0][0].message
    expect(loggedMessage).toContain('bytes=13')
    expect(loggedMessage).not.toContain('typed content')

    // Retry next debounce window.
    await vi.advanceTimersByTimeAsync(500)
    expect(filesystemApi.writeFile).toHaveBeenCalledTimes(2)
  })

  it('row 3 — autosave off: no automatic write calls, buffer stays dirty', async () => {
    setAutoSave(false)

    useEditorStore.getState().updateContent(path, 'typed content')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(filesystemApi.writeFile).not.toHaveBeenCalled()
    expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(true)
  })

  it('row 4 — save race: a second concurrent save awaits the first write instead of interleaving', async () => {
    let releaseFirst!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const writeOrder: string[] = []

    vi.mocked(filesystemApi.writeFile).mockImplementation(async (_p, content) => {
      writeOrder.push(`start:${content}`)
      if (content === 'v1') await firstWrite
      writeOrder.push(`end:${content}`)
      return { success: true, data: undefined }
    })

    seedOpenFile('v1')
    const first = useEditorStore.getState().saveFile(path)
    // Wait for the first write to be pending in the API.
    await vi.advanceTimersByTimeAsync(0)
    expect(writeOrder).toEqual(['start:v1'])

    // User edits while the first save is in flight; a second save is
    // requested (button tap / Ctrl+S racing the debounce).
    useEditorStore.getState().updateContent(path, 'v2')
    const second = useEditorStore.getState().saveFile(path)

    // The second call must NOT start a new write while the first is in flight.
    await vi.advanceTimersByTimeAsync(0)
    expect(writeOrder).toEqual(['start:v1'])

    releaseFirst()
    const [firstSaved, secondSaved] = await Promise.all([first, second])

    expect(firstSaved).toBe(true)
    expect(secondSaved).toBe(true)
    // Serialized: first write completes before the second starts — no
    // interleaved/corrupt write order.
    expect(writeOrder).toEqual(['start:v1', 'end:v1', 'start:v2', 'end:v2'])
  })

  it('row 4 — queued save skips the redundant write when the first one already persisted the buffer (no dirty content left)', async () => {
    let releaseFirst!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    vi.mocked(filesystemApi.writeFile).mockImplementation(async (_p, content) => {
      if (content === 'v1') await firstWrite
      return { success: true, data: undefined }
    })

    seedOpenFile('v1')
    const first = useEditorStore.getState().saveFile(path)
    await vi.advanceTimersByTimeAsync(0)

    // Second request for the same unchanged buffer races the first.
    const second = useEditorStore.getState().saveFile(path)

    releaseFirst()
    const [firstSaved, secondSaved] = await Promise.all([first, second])

    expect(firstSaved).toBe(true)
    expect(secondSaved).toBe(true)
    // Only ONE write hit the API — the queued call found nothing dirty.
    expect(filesystemApi.writeFile).toHaveBeenCalledTimes(1)
  })

  it('row 5 — dirty-check skip: saveFile on a clean buffer makes no write call', async () => {
    seedOpenFile('original')

    const saved = await useEditorStore.getState().saveFile(path)

    // No write API call; the clean-buffer contract reports "nothing to do"
    // as success (the buffer already matches disk) so callers don't toast a
    // bogus failure.
    expect(saved).toBe(true)
    expect(filesystemApi.writeFile).not.toHaveBeenCalled()
    expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(false)
  })

  it('row 5 — autosave fires with no changes (buffer returned to original): no write call', async () => {
    setAutoSave(true, 500)

    useEditorStore.getState().updateContent(path, 'typed content')
    useEditorStore.getState().updateContent(path, 'original')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(filesystemApi.writeFile).not.toHaveBeenCalled()
  })

  it('successful save logs a success boundary via the info idiom (bytes only, no content)', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    useEditorStore.getState().updateContent(path, 'typed content')

    await useEditorStore.getState().saveFile(path)

    expect(infoSpy).toHaveBeenCalledTimes(1)
    const logged = infoSpy.mock.calls[0].join(' ')
    expect(logged).toContain('editor save saved')
    expect(logged).toContain('bytes=13')
    expect(logged).not.toContain('typed content')
    // Success must NOT pollute the frontend-error channel.
    expect(logFrontendError).not.toHaveBeenCalled()
    infoSpy.mockRestore()
  })
})
