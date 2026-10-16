import { COMMAND_RESULT_CODES } from '@shared/types/ipc.types'
import { toast } from 'sonner'
import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { filesystemApi } from '@/lib/api'
import {
  cancelAllAutoSaves,
  cancelAutoSave,
  clearAutoSaveFailure,
  scheduleAutoSave
} from '@/lib/editor-auto-save'
import { flushEditorContent } from '@/lib/editor-content-flush'
import { fileNeedsAttention } from '@/lib/editor-file-attention'
import { markEditorSelfSave } from '@/lib/editor-self-save'
import { logFrontendError } from '@/lib/log-api'
import { scheduleGitStatusRefreshForPath } from '@/lib/schedule-git-status-refresh'
import { sha256Hex } from '@/lib/sha256-hex'

/** Saves currently in flight, by file path (in-flight guard, QA r2 story 4). */
const savesInFlight = new Map<string, Promise<boolean>>()

/**
 * Boundary log for editor saves. Failures route through logFrontendError
 * (error level → Tauri command / server `/log/frontend-error`); successes
 * route through logFrontendError at the info level (story 8 extended the
 * level set) so they land in the backend log file without polluting the
 * error channel. File basename + byte length only — never full contents,
 * secrets, or absolute paths.
 */
function logSaveBoundary(
  path: string,
  byteLength: number,
  outcome: 'saved' | 'failed',
  error?: string
): void {
  const name = path.split(/[\\/]/).pop() || path
  const detail = `file=${name} bytes=${byteLength}${error ? ` error=${error}` : ''}`
  if (outcome === 'failed') {
    void logFrontendError({
      level: 'error',
      source: 'editor-store.saveFile',
      message: `editor save failed ${detail}`
    })
    return
  }
  void logFrontendError({
    level: 'info',
    source: 'editor-store.saveFile',
    message: `editor save succeeded ${detail}`
  })
}

/**
 * The host refused a save because the file changed on disk since it was read
 * (`PRECONDITION_FAILED`): same "File changed externally" notice the file
 * watcher raises for a dirty buffer. Reload takes the disk version; Overwrite
 * keeps the buffer and saves it without a precondition.
 */
function notifyExternalChange(path: string): void {
  toast('File changed externally', {
    description: path.split(/[\\/]/).pop() || path,
    action: {
      label: 'Reload',
      onClick: () => {
        void useEditorStore.getState().reloadFile(path, { force: true })
      }
    },
    cancel: {
      label: 'Overwrite',
      onClick: () => {
        void useEditorStore.getState().overwriteFile(path)
      }
    }
  })
}

/** Write failures that say nothing about whether the host applied the write. */
const UNCERTAIN_WRITE_CODES: ReadonlySet<string> = new Set([
  'NETWORK_ERROR',
  COMMAND_RESULT_CODES.OUTCOME_UNKNOWN,
  COMMAND_RESULT_CODES.COMMAND_IN_PROGRESS
])

const EDITOR_TAB_LIMIT = 15

function getExtname(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() || filePath
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return ''
  return name.slice(dotIndex)
}

function detectLanguage(filePath: string): string {
  const ext = getExtname(filePath).slice(1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    css: 'css',
    scss: 'css',
    html: 'html',
    htm: 'html',
    astro: 'astro',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    svg: 'xml',
    sh: 'shell',
    bash: 'shell',
    py: 'python',
    rs: 'rust',
    go: 'go',
    toml: 'toml'
  }
  return map[ext] || ''
}

function getDefaultViewMode(filePath: string): 'code' | 'markdown' {
  const ext = getExtname(filePath).slice(1).toLowerCase()
  return ext === 'md' ? 'markdown' : 'code'
}

export interface EditorFileState {
  filePath: string
  content: string
  originalContent: string
  isDirty: boolean
  language: string
  lastModified: number
  viewMode: 'code' | 'markdown'
  cursorPosition: { line: number; col: number }
  scrollTop: number
  operationStatus: 'idle' | 'saving' | 'reloading' | 'saved'
  /**
   * sha256 of the bytes this buffer was last read from / saved to (web host
   * only): sent as the `expected` precondition of the next save so a write over
   * a file changed elsewhere is refused instead of overwriting it.
   */
  contentHash?: string
  /**
   * The host reports content hashes for this file (web): kept when `contentHash`
   * is dropped (overwrite) so the next successful save re-establishes it.
   */
  tracksHash?: true
  /** The host refused the last save (`PRECONDITION_FAILED`): the file changed on disk. */
  externalConflict?: boolean
  /**
   * Set when a restored unsaved draft differs from a file that changed on disk
   * after the draft was saved. `content` holds the disk version; the draft is
   * kept here until the user resolves it (never silently dropped).
   */
  draftConflict?: { draftContent: string; draftSavedAt: number }
}

/**
 * Reconcile a persisted unsaved draft with a freshly opened file (pure).
 * - same text as disk: nothing to restore
 * - disk not newer than the draft: apply the draft as an unsaved edit
 * - disk newer: keep disk content and record the draft as a conflict
 */
export function reconcileDraft(
  file: EditorFileState,
  draft: { content: string; savedAt: number }
): EditorFileState {
  if (file.content === draft.content) return file
  if (file.lastModified <= draft.savedAt) {
    const { draftConflict: _cleared, ...rest } = file
    return { ...rest, content: draft.content, isDirty: draft.content !== file.originalContent }
  }
  return {
    ...file,
    draftConflict: { draftContent: draft.content, draftSavedAt: draft.savedAt }
  }
}

export interface EditorState {
  openFiles: Map<string, EditorFileState>
  activeFilePath: string | null

  openFile: (path: string) => Promise<void>
  closeFile: (path: string) => void
  closeFileIfIdle: (path: string) => boolean
  updateContent: (path: string, content: string) => void
  saveFile: (path: string) => Promise<boolean>
  saveAllDirty: () => Promise<void>
  setViewMode: (path: string, mode: 'code' | 'markdown') => void
  updateCursorPosition: (path: string, line: number, col: number) => void
  updateScrollTop: (path: string, scrollTop: number) => void
  /**
   * Save the buffer over whatever is on disk: drops the stored hash (and the
   * conflict flag) so the write carries no precondition. The user's answer to
   * "File changed externally".
   */
  overwriteFile: (path: string) => Promise<boolean>
  /** `force`: reload even a dirty buffer (the user chose to take the disk version). */
  reloadFile: (path: string, options?: { force?: boolean }) => Promise<void>
  setActiveFilePath: (path: string | null) => void
  clearAllFiles: () => void
  hasDirtyFiles: () => boolean
  getDirtyFileCount: () => number
  restoreDraft: (
    path: string,
    draft: { content: string; savedAt: number }
  ) => 'applied' | 'conflict' | 'unchanged'
  resolveDraftConflict: (path: string, choice: 'draft' | 'disk') => void
  getOpenFilePaths: () => string[]
}

export const useEditorStore = create<EditorState>((set, get) => ({
  openFiles: new Map<string, EditorFileState>(),
  activeFilePath: null,

  openFile: async (path: string): Promise<void> => {
    const { openFiles } = get()

    // Already open, just activate
    if (openFiles.has(path)) {
      set({ activeFilePath: path })
      return
    }

    // Read file content. readFile() now performs size + binary checks in a
    // single IPC round-trip pair (stat + readTextFile), avoiding the previous
    // getFileInfo() pre-check that doubled the IPC cost (issue #378).
    const result = await filesystemApi.readFile(path)
    if (!result.success) {
      throw new Error(result.error)
    }

    const newFiles = new Map(get().openFiles)

    // Check tab limit - close oldest inactive non-dirty tab
    if (newFiles.size >= EDITOR_TAB_LIMIT) {
      const { activeFilePath } = get()
      let oldestPath: string | null = null
      let oldestTime = Infinity

      newFiles.forEach((file, filePath) => {
        if (
          filePath !== activeFilePath &&
          !fileNeedsAttention(file) &&
          file.lastModified < oldestTime
        ) {
          oldestTime = file.lastModified
          oldestPath = filePath
        }
      })

      if (oldestPath) {
        newFiles.delete(oldestPath)
      } else {
        toast.warning('Too many open tabs', {
          description: 'Close a tab or save your changes to open more files.'
        })
        return
      }
    }

    const fileState: EditorFileState = {
      filePath: path,
      content: result.data.content,
      originalContent: result.data.content,
      isDirty: false,
      language: detectLanguage(path),
      lastModified: result.data.modifiedAt,
      ...(result.data.contentHash
        ? { contentHash: result.data.contentHash, tracksHash: true as const }
        : {}),
      viewMode: getDefaultViewMode(path),
      cursorPosition: { line: 1, col: 1 },
      scrollTop: 0,
      operationStatus: 'idle'
    }

    newFiles.set(path, fileState)
    set({ openFiles: newFiles, activeFilePath: path })
  },

  closeFile: (path: string): void => {
    cancelAutoSave(path)
    const { openFiles, activeFilePath } = get()
    const newFiles = new Map(openFiles)
    newFiles.delete(path)

    let newActive = activeFilePath
    if (activeFilePath === path) {
      const paths = Array.from(newFiles.keys())
      newActive = paths.length > 0 ? paths[paths.length - 1] : null
    }

    set({ openFiles: newFiles, activeFilePath: newActive })
  },

  closeFileIfIdle: (path: string): boolean => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return false

    if (file.operationStatus === 'saving' || file.operationStatus === 'reloading') {
      return false
    }

    const { openFiles: openFiles2, activeFilePath } = get()
    const newFiles = new Map(openFiles2)
    newFiles.delete(path)
    cancelAutoSave(path)

    let newActive = activeFilePath
    if (activeFilePath === path) {
      const paths = Array.from(newFiles.keys())
      newActive = paths.length > 0 ? paths[paths.length - 1] : null
    }

    set({ openFiles: newFiles, activeFilePath: newActive })
    return true
  },

  updateContent: (path: string, content: string): void => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return
    // The editor is read-only while a draft conflict is unresolved: an edit
    // here would live outside the two stored buffers (disk + draft) and be
    // lost on switch. Drop it rather than let it diverge.
    if (file.draftConflict) return

    const newFiles = new Map(openFiles)
    const isDirty = content !== file.originalContent
    newFiles.set(path, {
      ...file,
      content,
      isDirty
    })
    set({ openFiles: newFiles })

    // Auto-save (GH-539): every real buffer change pushes the debounce window;
    // returning to the original content clears it (and any pending timer).
    if (content !== file.content) {
      clearAutoSaveFailure(path)
      if (isDirty) {
        scheduleAutoSave(path)
      } else {
        cancelAutoSave(path)
      }
    }
  },

  saveFile: async (path: string): Promise<boolean> => {
    // In-flight guard (QA r2 story 4): serialize concurrent save requests for
    // the same path (autosave debounce + manual button/Ctrl+S can race). The
    // second caller awaits the first write's completion, then re-checks
    // dirtiness — a no-longer-dirty file skips the redundant write entirely,
    // and a still-dirty file writes the freshest buffer.
    const inFlight = savesInFlight.get(path)
    if (inFlight) {
      // Await the first save, then re-run (dirty-check decides whether a
      // second write is needed at all).
      return inFlight.then(() => get().saveFile(path))
    }

    const save = (async (): Promise<boolean> => {
      // CodeRabbit: a registered flusher may reject (its contract permits
      // it). A rejection here previously escaped saveFile's try block — no
      // boundary log, no failure cleanup, and saveAllDirty (which awaits
      // each saveFile without a per-file boundary) would stop at this file.
      // Catch it, log the save failure, and report false — the flusher's
      // unsaved content stays marked dirty for the next attempt.
      try {
        await flushEditorContent(path)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        logSaveBoundary(path, -1, 'failed', `content flush failed: ${detail}`)
        return false
      }

      const { openFiles } = get()
      const file = openFiles.get(path)
      if (!file) return false

      // An unresolved draft conflict means the buffer is the disk version
      // while a newer-than-disk draft is still pending a user decision;
      // writing now would bury that choice, so refuse until it is resolved.
      if (file.draftConflict) {
        void logFrontendError({
          level: 'info',
          source: 'editor-store.saveFile',
          message: `save skipped for ${path.split(/[\\/]/).pop() || path}: unresolved draft conflict`
        })
        return false
      }

      // Dirty-check skip: a save request for a buffer that already matches
      // the original content must not hit the write API — the autosave
      // "fires with no changes" row. The content IS on disk (a prior save
      // persisted it), so report success rather than failure.
      if (!file.isDirty) return true

      const snapshotContent = file.content
      const newFiles = new Map(get().openFiles)
      newFiles.set(path, { ...file, operationStatus: 'saving' })
      set({ openFiles: newFiles })

      try {
        let result = file.contentHash
          ? await filesystemApi.writeFile(path, snapshotContent, {
              expected: { sha256: file.contentHash }
            })
          : await filesystemApi.writeFile(path, snapshotContent)
        // The reply was lost or its outcome is unknown: the host may or may not
        // have applied the write. Read the file back. If it holds our content the
        // write landed, so treat it as saved. Otherwise keep the hash this buffer
        // was read at: the next save is checked against it, so it never
        // overwrites a change made after the unknown write.
        if (!result.success && file.tracksHash && UNCERTAIN_WRITE_CODES.has(result.code)) {
          const disk = await filesystemApi.readFile(path)
          if (disk.success && disk.data.content === snapshotContent) {
            result = { success: true, data: undefined }
          }
        }
        if (!result.success) {
          const conflict = result.code === COMMAND_RESULT_CODES.PRECONDITION_FAILED
          // An unchecked write (an overwrite the user chose) whose outcome could
          // not be confirmed has no hash to check a retry against: stop automatic
          // saves and let the user decide again (Reload or Overwrite).
          const needsDecision =
            !conflict &&
            !file.contentHash &&
            file.tracksHash === true &&
            UNCERTAIN_WRITE_CODES.has(result.code)
          const resetFiles = new Map(get().openFiles)
          const current = resetFiles.get(path)
          if (current) {
            resetFiles.set(path, {
              ...current,
              operationStatus: 'idle',
              ...(conflict || needsDecision ? { externalConflict: true } : {})
            })
            set({ openFiles: resetFiles })
          }
          if (conflict) notifyExternalChange(path)
          logSaveBoundary(path, snapshotContent.length, 'failed', result.error)
          return false
        }
        // The host now holds exactly `snapshotContent`; its hash is the next
        // save's precondition.
        const savedHash = file.tracksHash ? sha256Hex(snapshotContent) : undefined

        const updatedFiles = new Map(get().openFiles)
        const current = updatedFiles.get(path)
        if (!current) return false

        // Only mark clean if buffer hasn't changed since the snapshot
        const bufferUnchanged = current.content === snapshotContent
        updatedFiles.set(path, {
          ...current,
          originalContent: current.content,
          isDirty: !bufferUnchanged,
          lastModified: Date.now(),
          operationStatus: 'saved',
          externalConflict: false,
          ...(savedHash ? { contentHash: savedHash } : {})
        })
        set({ openFiles: updatedFiles })
        markEditorSelfSave(path)
        scheduleGitStatusRefreshForPath(path)

        window.setTimeout(() => {
          const latest = get().openFiles.get(path)
          if (latest?.operationStatus === 'saved') {
            const resetFiles = new Map(get().openFiles)
            const entry = resetFiles.get(path)
            if (entry) {
              resetFiles.set(path, { ...entry, operationStatus: 'idle' })
              set({ openFiles: resetFiles })
            }
          }
        }, 1500)

        logSaveBoundary(path, snapshotContent.length, 'saved')
        return true
      } catch (error) {
        const resetFiles = new Map(get().openFiles)
        const current = resetFiles.get(path)
        if (current) {
          resetFiles.set(path, { ...current, operationStatus: 'idle' })
          set({ openFiles: resetFiles })
        }
        logSaveBoundary(
          path,
          snapshotContent.length,
          'failed',
          error instanceof Error ? error.message : String(error)
        )
        return false
      }
    })()

    savesInFlight.set(path, save)
    try {
      return await save
    } finally {
      // Only clear when this save is still the latest one for the path (a
      // queued re-save inside the chain sets its own entry first).
      if (savesInFlight.get(path) === save) {
        savesInFlight.delete(path)
      }
    }
  },

  saveAllDirty: async (): Promise<void> => {
    const { openFiles } = get()
    const dirtyPaths: string[] = []
    openFiles.forEach((file, path) => {
      if (file.isDirty) dirtyPaths.push(path)
    })

    for (const path of dirtyPaths) {
      await get().saveFile(path)
    }
  },

  setViewMode: (path: string, mode: 'code' | 'markdown'): void => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return

    const newFiles = new Map(openFiles)
    newFiles.set(path, { ...file, viewMode: mode })
    set({ openFiles: newFiles })
  },

  updateCursorPosition: (path: string, line: number, col: number): void => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return

    const newFiles = new Map(openFiles)
    newFiles.set(path, { ...file, cursorPosition: { line, col } })
    set({ openFiles: newFiles })
  },

  updateScrollTop: (path: string, scrollTop: number): void => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return

    const newFiles = new Map(openFiles)
    newFiles.set(path, { ...file, scrollTop })
    set({ openFiles: newFiles })
  },

  overwriteFile: async (path: string): Promise<boolean> => {
    const file = get().openFiles.get(path)
    if (!file) return false
    const files = new Map(get().openFiles)
    files.set(path, { ...file, contentHash: undefined, externalConflict: false })
    set({ openFiles: files })
    return get().saveFile(path)
  },

  reloadFile: async (path: string, options?: { force?: boolean }): Promise<void> => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return

    // Don't reload dirty (or draft-conflicted) files silently
    if ((file.isDirty && !options?.force) || file.draftConflict) return

    const snapshotContent = file.content
    const newFiles = new Map(get().openFiles)
    newFiles.set(path, { ...file, operationStatus: 'reloading' })
    set({ openFiles: newFiles })

    try {
      const result = await filesystemApi.readFile(path)
      if (!result.success) {
        const resetFiles = new Map(get().openFiles)
        const current = resetFiles.get(path)
        if (current) {
          resetFiles.set(path, { ...current, operationStatus: 'idle' })
          set({ openFiles: resetFiles })
        }
        return
      }

      const updatedFiles = new Map(get().openFiles)
      const current = updatedFiles.get(path)
      if (!current) return

      // Only replace buffer if it hasn't changed since the snapshot
      const bufferUnchanged = current.content === snapshotContent
      if (bufferUnchanged) {
        updatedFiles.set(path, {
          ...current,
          content: result.data.content,
          originalContent: result.data.content,
          isDirty: false,
          lastModified: result.data.modifiedAt,
          contentHash: result.data.contentHash,
          ...(result.data.contentHash ? { tracksHash: true as const } : {}),
          externalConflict: false,
          operationStatus: 'idle'
        })
      } else {
        updatedFiles.set(path, {
          ...current,
          operationStatus: 'idle'
        })
      }
      set({ openFiles: updatedFiles })
    } catch {
      const resetFiles = new Map(get().openFiles)
      const current = resetFiles.get(path)
      if (current) {
        resetFiles.set(path, { ...current, operationStatus: 'idle' })
        set({ openFiles: resetFiles })
      }
    }
  },

  setActiveFilePath: (path: string | null): void => {
    set({ activeFilePath: path })
  },

  clearAllFiles: (): void => {
    cancelAllAutoSaves()
    set({ openFiles: new Map(), activeFilePath: null })
  },

  restoreDraft: (path, draft) => {
    const file = get().openFiles.get(path)
    if (!file) return 'unchanged'

    const next = reconcileDraft(file, draft)
    if (next === file) return 'unchanged'

    const newFiles = new Map(get().openFiles)
    newFiles.set(path, next)
    set({ openFiles: newFiles })

    if (next.draftConflict) return 'conflict'
    if (next.isDirty) scheduleAutoSave(path)
    return 'applied'
  },

  resolveDraftConflict: (path, choice) => {
    const file = get().openFiles.get(path)
    if (!file?.draftConflict) return

    const { draftConflict, ...rest } = file
    const next: EditorFileState =
      choice === 'draft'
        ? {
            ...rest,
            content: draftConflict.draftContent,
            isDirty: draftConflict.draftContent !== file.originalContent
          }
        : rest
    const newFiles = new Map(get().openFiles)
    newFiles.set(path, next)
    set({ openFiles: newFiles })

    if (choice === 'draft') {
      clearAutoSaveFailure(path)
      if (next.isDirty) scheduleAutoSave(path)
      else cancelAutoSave(path)
    } else if (next.isDirty) {
      // The kept disk-side buffer may carry edits typed during the conflict.
      scheduleAutoSave(path)
    }
  },

  hasDirtyFiles: (): boolean => {
    return Array.from(get().openFiles.values()).some(fileNeedsAttention)
  },

  getDirtyFileCount: (): number => {
    return Array.from(get().openFiles.values()).filter(fileNeedsAttention).length
  },

  getOpenFilePaths: (): string[] => {
    return Array.from(get().openFiles.keys())
  }
}))

// Selector hooks
export function useOpenFiles(): Map<string, EditorFileState> {
  return useEditorStore((state) => state.openFiles)
}

export function useOpenFilePaths(): string[] {
  return useEditorStore(useShallow((state) => Array.from(state.openFiles.keys())))
}

export function useOpenFile(filePath: string): EditorFileState | undefined {
  return useEditorStore((state) => state.openFiles.get(filePath))
}

export function useActiveFile(): EditorFileState | undefined {
  return useEditorStore((state) => {
    if (!state.activeFilePath) return undefined
    return state.openFiles.get(state.activeFilePath)
  })
}

export function useActiveFilePath(): string | null {
  return useEditorStore((state) => state.activeFilePath)
}

export function useEditorActions(): Pick<
  EditorState,
  | 'openFile'
  | 'closeFile'
  | 'updateContent'
  | 'saveFile'
  | 'saveAllDirty'
  | 'setViewMode'
  | 'updateCursorPosition'
  | 'updateScrollTop'
  | 'reloadFile'
  | 'setActiveFilePath'
  | 'clearAllFiles'
> {
  return useEditorStore(
    useShallow((state) => ({
      openFile: state.openFile,
      closeFile: state.closeFile,
      closeFileIfIdle: state.closeFileIfIdle,
      updateContent: state.updateContent,
      saveFile: state.saveFile,
      saveAllDirty: state.saveAllDirty,
      setViewMode: state.setViewMode,
      updateCursorPosition: state.updateCursorPosition,
      updateScrollTop: state.updateScrollTop,
      reloadFile: state.reloadFile,
      setActiveFilePath: state.setActiveFilePath,
      clearAllFiles: state.clearAllFiles
    }))
  )
}

export function useDirtyFiles(): string[] {
  return useEditorStore(
    useShallow((state) => {
      const dirty: string[] = []
      state.openFiles.forEach((file, path) => {
        if (fileNeedsAttention(file)) dirty.push(path)
      })
      return dirty
    })
  )
}

export { detectLanguage, getDefaultViewMode }
