import { toast } from 'sonner'
import { logFrontendError } from '@/lib/log-api'
import { basename } from '@/lib/path-basename'
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
/**
 * Auto-save writes a fired timer has started and not yet finished, by path.
 * The timer callback removes its own timer before `saveFile` runs, so without
 * this a flush could not tell that a write is still on its way to disk.
 * Resolves to whether the write succeeded.
 */
const inFlightAutoSaves = new Map<string, Promise<boolean>>()

function clearTimer(filePath: string): void {
  const timer = autoSaveTimers.get(filePath)
  if (timer !== undefined) {
    clearTimeout(timer)
    autoSaveTimers.delete(filePath)
  }
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
      // The host refused the last save because the file changed on disk: only
      // the user's choice on the "File changed externally" notice (Reload or
      // Overwrite) resolves that, not a retry.
      if (file.externalConflict) return

      // A save/reload in flight will finish on its own; wait another window
      // instead of writing concurrently or dropping the pending save.
      if (file.operationStatus === 'saving' || file.operationStatus === 'reloading') {
        scheduleAutoSave(filePath)
        return
      }

      const run: Promise<boolean> = useEditorStore
        .getState()
        .saveFile(filePath)
        .then((saved) => {
          const latest = useEditorStore.getState().openFiles.get(filePath)
          const stillDirty = Boolean(latest?.isDirty)
          if (saved) {
            failedAutoSavePaths.delete(filePath)
            return true
          }
          if (latest?.kind !== 'text' || !stillDirty || latest.externalConflict) return false
          // Toast once per failure episode; the retry keeps trying quietly.
          if (!failedAutoSavePaths.has(filePath)) {
            failedAutoSavePaths.add(filePath)
            toast.error('Auto save failed', { description: basename(filePath) })
          }
          if (useAppSettingsStore.getState().settings.editorAutoSave) {
            scheduleAutoSave(filePath)
          }
          return false
        })
        .catch(() => {
          // saveFile never rejects in practice (it catches internally and
          // returns false), but a flush registration that throws lands here;
          // treat it as a failed autosave episode — retry, stay dirty.
          const stillDirty = Boolean(useEditorStore.getState().openFiles.get(filePath)?.isDirty)
          if (!stillDirty) return false
          if (!failedAutoSavePaths.has(filePath)) {
            failedAutoSavePaths.add(filePath)
            toast.error('Auto save failed', { description: basename(filePath) })
          }
          if (useAppSettingsStore.getState().settings.editorAutoSave) {
            scheduleAutoSave(filePath)
          }
          return false
        })
        .finally(() => {
          if (inFlightAutoSaves.get(filePath) === run) inFlightAutoSaves.delete(filePath)
        })
      inFlightAutoSaves.set(filePath, run)
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

/** Schedule auto-save for every already-dirty open file (toggle-on). Files
 * mid-save/reload get a deferred timer — scheduleAutoSave re-checks status at
 * fire time — so nothing dirtied before the toggle is skipped. */
export function scheduleAllDirtyAutoSaves(): void {
  useEditorStore.getState().openFiles.forEach((file, filePath) => {
    if (file.isDirty) {
      scheduleAutoSave(filePath)
    }
  })
}

/** Number of pending auto-save timers (used by tests). */
export function getPendingAutoSaveCount(): number {
  return autoSaveTimers.size
}

/**
 * Write every file with a pending auto-save timer NOW (project switch / close
 * barrier), and wait for auto-save writes a fired timer already started. Each
 * timer is cleared; the file is saved only if it is still open, dirty and not
 * mid saving/reloading (a busy file keeps a fresh timer so its pending edit is
 * not dropped). A failed save leaves the file dirty, is logged (no toast — the
 * caller is mid-flow) and re-arms the normal retry timer. Best effort: it
 * never throws, and a busy or failing file stays unsaved.
 */
export async function flushPendingAutoSaves(): Promise<{ saved: string[]; failed: string[] }> {
  const timerPaths = new Set(autoSaveTimers.keys())
  for (const path of timerPaths) clearTimer(path)
  const paths = new Set([...timerPaths, ...inFlightAutoSaves.keys()])

  const saved: string[] = []
  const failed: string[] = []

  await Promise.all(
    Array.from(paths, async (path) => {
      // A write a fired timer already started: wait for it, then re-check.
      const pending = inFlightAutoSaves.get(path)
      const inFlightOk = pending ? await pending : undefined

      const file = useEditorStore.getState().openFiles.get(path)
      if (!file?.isDirty) {
        if (inFlightOk === true) saved.push(path)
        return
      }
      if (!timerPaths.has(path)) {
        // In-flight only: that chain already toasted/re-armed on failure.
        if (inFlightOk === true) saved.push(path)
        else failed.push(path)
        return
      }
      if (file.operationStatus === 'saving' || file.operationStatus === 'reloading') {
        scheduleAutoSave(path)
        return
      }

      const name = basename(path)
      let ok = false
      try {
        ok = await useEditorStore.getState().saveFile(path)
      } catch (error) {
        void logFrontendError({
          level: 'warn',
          source: 'editor-auto-save.flush',
          // The error text can embed the absolute path: log the basename only.
          message: `flush save threw for ${name}`
        })
      }
      if (ok) {
        failedAutoSavePaths.delete(path)
        saved.push(path)
        return
      }

      // saveFile already boundary-logs a plain failure; skip the clean case
      // (file saved/closed concurrently) and report only still-dirty files.
      if (!useEditorStore.getState().openFiles.get(path)?.isDirty) return
      failed.push(path)
      void logFrontendError({
        level: 'warn',
        source: 'editor-auto-save.flush',
        message: `flush save failed for ${name}; file stays dirty`
      })
      if (useAppSettingsStore.getState().settings.editorAutoSave) {
        scheduleAutoSave(path)
      }
    })
  )

  return { saved, failed }
}
