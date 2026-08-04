import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelAllAutoSaves,
  cancelAutoSave,
  clearAutoSaveFailure,
  getPendingAutoSaveCount,
  scheduleAllDirtyAutoSaves,
  scheduleAutoSave
} from './editor-auto-save'

const mocks = vi.hoisted(() => ({
  openFiles: new Map<string, { isDirty: boolean; operationStatus: string }>(),
  saveFile: vi.fn(),
  settings: { editorAutoSave: true, editorAutoSaveDelayMs: 1000 },
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  })
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: {
    getState: () => ({
      openFiles: mocks.openFiles,
      saveFile: mocks.saveFile
    })
  }
}))

vi.mock('@/stores/app-settings-store', () => ({
  useAppSettingsStore: {
    getState: () => ({ settings: mocks.settings })
  }
}))

vi.mock('sonner', () => ({
  toast: mocks.toast
}))

describe('editor-auto-save (GH-539)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.openFiles = new Map()
    mocks.settings = { editorAutoSave: true, editorAutoSaveDelayMs: 1000 }
    mocks.saveFile.mockResolvedValue(true)
  })

  afterEach(() => {
    cancelAllAutoSaves()
    vi.useRealTimers()
  })

  function setOpenFile(
    path: string,
    overrides: Partial<{ isDirty: boolean; operationStatus: string }> = {}
  ) {
    mocks.openFiles.set(path, { isDirty: true, operationStatus: 'idle', ...overrides })
  }

  it('does not schedule when auto save is disabled', () => {
    mocks.settings.editorAutoSave = false
    setOpenFile('/project/a.txt')

    scheduleAutoSave('/project/a.txt')

    expect(getPendingAutoSaveCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(mocks.saveFile).not.toHaveBeenCalled()
  })

  it('saves a dirty idle file after the configured delay', () => {
    setOpenFile('/project/a.txt')

    scheduleAutoSave('/project/a.txt')
    vi.advanceTimersByTime(999)
    expect(mocks.saveFile).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(mocks.saveFile).toHaveBeenCalledTimes(1)
    expect(mocks.saveFile).toHaveBeenCalledWith('/project/a.txt')
    expect(getPendingAutoSaveCount()).toBe(0)
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  it('reschedules on repeated edits (debounce)', () => {
    setOpenFile('/project/a.txt')

    scheduleAutoSave('/project/a.txt')
    vi.advanceTimersByTime(800)
    scheduleAutoSave('/project/a.txt')
    vi.advanceTimersByTime(800)
    expect(mocks.saveFile).not.toHaveBeenCalled()

    vi.advanceTimersByTime(200)
    expect(mocks.saveFile).toHaveBeenCalledTimes(1)
  })

  it('skips the save when the file was closed before the timer fired', () => {
    setOpenFile('/project/a.txt')

    scheduleAutoSave('/project/a.txt')
    mocks.openFiles.delete('/project/a.txt')
    vi.advanceTimersByTime(1000)

    expect(mocks.saveFile).not.toHaveBeenCalled()
  })

  it('skips the save when the buffer is no longer dirty', () => {
    setOpenFile('/project/a.txt', { isDirty: false })

    scheduleAutoSave('/project/a.txt')
    vi.advanceTimersByTime(1000)

    expect(mocks.saveFile).not.toHaveBeenCalled()
  })

  it('waits another window when a save/reload is in flight, then saves', () => {
    setOpenFile('/project/a.txt', { operationStatus: 'saving' })

    scheduleAutoSave('/project/a.txt')
    vi.advanceTimersByTime(1000)
    expect(mocks.saveFile).not.toHaveBeenCalled()
    expect(getPendingAutoSaveCount()).toBe(1)

    mocks.openFiles.set('/project/a.txt', { isDirty: true, operationStatus: 'idle' })
    vi.advanceTimersByTime(1000)
    expect(mocks.saveFile).toHaveBeenCalledTimes(1)
  })

  it('toasts an error when the save fails and the file is still dirty', async () => {
    setOpenFile('/project/a.txt')
    mocks.saveFile.mockResolvedValue(false)

    scheduleAutoSave('/project/a.txt')
    await vi.advanceTimersByTimeAsync(1000)

    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Auto save failed',
      expect.objectContaining({ description: 'a.txt' })
    )
    // A failed attempt is retried after another full window.
    expect(getPendingAutoSaveCount()).toBe(1)
  })

  it('retries after failure and toasts only once per failure episode', async () => {
    setOpenFile('/project/a.txt')
    mocks.saveFile.mockResolvedValue(false)

    scheduleAutoSave('/project/a.txt')
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(mocks.saveFile).toHaveBeenCalledTimes(2)
    expect(mocks.toast.error).toHaveBeenCalledTimes(1)

    // A new edit re-arms failure reporting.
    clearAutoSaveFailure('/project/a.txt')
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.toast.error).toHaveBeenCalledTimes(2)
  })

  it('handles a rejecting saveFile without an unhandled rejection', async () => {
    setOpenFile('/project/a.txt')
    mocks.saveFile.mockRejectedValue(new Error('flusher exploded'))

    scheduleAutoSave('/project/a.txt')
    await vi.advanceTimersByTimeAsync(1000)

    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Auto save failed',
      expect.objectContaining({ description: 'a.txt' })
    )
    // Still dirty → retry scheduled.
    expect(getPendingAutoSaveCount()).toBe(1)
  })

  it('does not toast when the failure no longer applies (file closed meanwhile)', async () => {
    setOpenFile('/project/a.txt')
    mocks.saveFile.mockImplementation(async () => {
      mocks.openFiles.delete('/project/a.txt')
      return false
    })

    scheduleAutoSave('/project/a.txt')
    await vi.advanceTimersByTimeAsync(1000)

    expect(mocks.toast.error).not.toHaveBeenCalled()
    expect(getPendingAutoSaveCount()).toBe(0)
  })

  it('does not save after the user disables auto save while a timer is pending', async () => {
    setOpenFile('/project/a.txt')

    scheduleAutoSave('/project/a.txt')
    vi.advanceTimersByTime(600)
    mocks.settings.editorAutoSave = false
    await vi.advanceTimersByTimeAsync(400)

    expect(mocks.saveFile).not.toHaveBeenCalled()
    expect(getPendingAutoSaveCount()).toBe(0)
  })

  it('falls back to the default delay when the configured delay is not usable', () => {
    mocks.settings.editorAutoSaveDelayMs = Number.NaN
    setOpenFile('/project/a.txt')

    scheduleAutoSave('/project/a.txt')
    vi.advanceTimersByTime(999)
    expect(mocks.saveFile).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(mocks.saveFile).toHaveBeenCalledTimes(1)
  })

  it('scheduleAllDirtyAutoSaves queues every dirty file, deferring busy ones', () => {
    setOpenFile('/project/a.txt')
    setOpenFile('/project/b.txt', { operationStatus: 'saving' })
    setOpenFile('/project/c.txt', { isDirty: false })

    scheduleAllDirtyAutoSaves()

    // Both dirty files get timers (the busy one is deferred at fire time).
    expect(getPendingAutoSaveCount()).toBe(2)

    vi.advanceTimersByTime(1000)
    expect(mocks.saveFile).toHaveBeenCalledTimes(1)
    expect(mocks.saveFile).toHaveBeenCalledWith('/project/a.txt')

    // The busy file's timer deferred and re-scheduled; once idle it saves.
    mocks.openFiles.set('/project/b.txt', { isDirty: true, operationStatus: 'idle' })
    vi.advanceTimersByTime(1000)
    expect(mocks.saveFile).toHaveBeenCalledTimes(2)
    expect(mocks.saveFile).toHaveBeenCalledWith('/project/b.txt')
  })

  it('cancelAutoSave clears only the pending timer for that file', () => {
    setOpenFile('/project/a.txt')
    setOpenFile('/project/b.txt')

    scheduleAutoSave('/project/a.txt')
    scheduleAutoSave('/project/b.txt')
    cancelAutoSave('/project/a.txt')

    vi.advanceTimersByTime(1000)
    expect(mocks.saveFile).toHaveBeenCalledTimes(1)
    expect(mocks.saveFile).toHaveBeenCalledWith('/project/b.txt')
  })

  it('cancelAllAutoSaves clears every pending timer', () => {
    setOpenFile('/project/a.txt')
    setOpenFile('/project/b.txt')

    scheduleAutoSave('/project/a.txt')
    scheduleAutoSave('/project/b.txt')
    cancelAllAutoSaves()

    vi.advanceTimersByTime(10_000)
    expect(mocks.saveFile).not.toHaveBeenCalled()
    expect(getPendingAutoSaveCount()).toBe(0)
  })

  it('clamps tiny delay settings to the minimum window', () => {
    mocks.settings.editorAutoSaveDelayMs = 10
    setOpenFile('/project/a.txt')

    scheduleAutoSave('/project/a.txt')
    vi.advanceTimersByTime(99)
    expect(mocks.saveFile).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(mocks.saveFile).toHaveBeenCalledTimes(1)
  })

  it('reads the current delay when scheduling', () => {
    setOpenFile('/project/a.txt')
    mocks.settings.editorAutoSaveDelayMs = 2000

    scheduleAutoSave('/project/a.txt')
    vi.advanceTimersByTime(1500)
    expect(mocks.saveFile).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    expect(mocks.saveFile).toHaveBeenCalledTimes(1)
  })
})
