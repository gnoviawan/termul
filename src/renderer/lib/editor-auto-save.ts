import { toast } from 'sonner'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useEditorStore } from '@/stores/editor-store'

/**
 * Debounced auto-save for editor files (GH-539). One timer per open file path;
 * every edit resets the timer. A timer only writes when auto-save is still
 * enabled and the file is still open, dirty, and not mid-operation, so it
 * never races a manual save or reload. Auto-save writes silently through
 * `saveFile` (no success toast) — the tab checkmark and dirty dot are the
 * indicators.
 */

const MIN_AUTO_SAVE_DELAY_MS = 100
const DEFAULT_AUTO_SAVE_DELAY_MS = 1000

const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Paths whose last auto-save failed; suppresses repeat toasts until the next edit. */
const failedAutoSavePaths = new Set<string>()

function clearTimer(filePath: string): void {
  const timer = autoSaveTimers.get(filePath)
  if (timer !== undefined) {
    clearTimeout(timer)
    autoSaveTimers.delete(filePath)
  }
}

function getBasename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

function resolveDelayMs(): number {
  const raw = useAppSettingsStore.getState().settings.editorAutoSaveDelayMs
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AUTO_SAVE_DELAY_MS
  return Math.max(raw, MIN_AUTO_SAVE_DELAY_MS)
}

export function scheduleAutoSave(filePath: string): void {
  const { settings } = useAppSettingsStore.getState()
  if (!settings.editorAutoSave) return

  clearTimer(filePath)
  autoSaveTimers.set(
    filePath,
    setTimeout(() => {
      autoSaveTimers.delete(filePath)

      // The user may have turned auto save off while the timer was pending.
      if (!useAppSettingsStore.getState().settings.editorAutoSave) return

      const file = useEditorStore.getState().openFiles.get(filePath)
      if (!file || !file.isDirty) return

      // A save/reload in flight will finish on its own; wait another window
      // instead of writing concurrently or dropping the pending save.
      if (file.operationStatus === 'saving' || file.operationStatus === 'reloading') {
        scheduleAutoSave(filePath)
        return
      }

      void useEditorStore
        .getState()
        .saveFile(filePath)
        .then((saved) => {
          const stillDirty = Boolean(useEditorStore.getState().openFiles.get(filePath)?.isDirty)
          if (saved) {
            failedAutoSavePaths.delete(filePath)
            return
          }
          if (!stillDirty) return
          // Toast once per failure episode; the retry keeps trying quietly.
          if (!failedAutoSavePaths.has(filePath)) {
            failedAutoSavePaths.add(filePath)
            toast.error('Auto save failed', { description: getBasename(filePath) })
          }
          if (useAppSettingsStore.getState().settings.editorAutoSave) {
            scheduleAutoSave(filePath)
          }
        })
        .catch(() => {
          const stillDirty = Boolean(useEditorStore.getState().openFiles.get(filePath)?.isDirty)
          if (!stillDirty) return
          if (!failedAutoSavePaths.has(filePath)) {
            failedAutoSavePaths.add(filePath)
            toast.error('Auto save failed', { description: getBasename(filePath) })
          }
          if (useAppSettingsStore.getState().settings.editorAutoSave) {
            scheduleAutoSave(filePath)
          }
        })
    }, resolveDelayMs())
  )
}

export function cancelAutoSave(filePath: string): void {
  clearTimer(filePath)
  failedAutoSavePaths.delete(filePath)
}

export function cancelAllAutoSaves(): void {
  for (const timer of autoSaveTimers.values()) {
    clearTimeout(timer)
  }
  autoSaveTimers.clear()
  failedAutoSavePaths.clear()
}

/** New user edits re-arm failure reporting (one toast per failure episode). */
export function clearAutoSaveFailure(filePath: string): void {
  failedAutoSavePaths.delete(filePath)
}

/** Schedule auto-save for every already-dirty open file (toggle-on). */
export function scheduleAllDirtyAutoSaves(): void {
  useEditorStore.getState().openFiles.forEach((file, filePath) => {
    if (file.isDirty && file.operationStatus !== 'saving' && file.operationStatus !== 'reloading') {
      scheduleAutoSave(filePath)
    }
  })
}

/** Number of pending auto-save timers (used by tests). */
export function getPendingAutoSaveCount(): number {
  return autoSaveTimers.size
}
