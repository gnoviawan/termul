/**
 * DirectoryPicker — web/remote mode's in-app folder picker (Story: Web/remote
 * project creation).
 *
 * In web/remote mode there is no native `dialog.open`, so `NewProjectModal`'s
 * Browse button can't open an OS folder dialog. This component fills that gap:
 * it is mounted once at app root (web mode only) and registers its opener with
 * `dialogApi` via `registerWebDirectoryPicker`. When `dialogApi.selectDirectory()`
 * is called in web mode, it invokes the registered opener, which opens this
 * modal. The user navigates host directories (one level at a time via
 * `GET /fs/browse`), then either selects the current folder (resolves with its
 * path) or cancels (resolves with a CANCELLED `IpcResult`).
 *
 * Single-level navigation: `/fs/browse` returns one level of children; the
 * picker re-calls it when the user descends into a directory. A "go up"
 * affordance ascends one level. Only directory entries are shown (the common
 * UX for folder pickers); files are filtered client-side.
 *
 * Style matches `NewProjectModal` / `ConfirmDialog` (framer-motion modal,
 * Tailwind + shadcn token classes).
 */

import type { DirectoryEntry, IpcResult } from '@shared/types/ipc.types'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, ChevronRight, Folder, Loader2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { _resetWebDirectoryPickerForTesting, registerWebDirectoryPicker } from '@/lib/dialog-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { webServerDialog } from '@/lib/web-server-api'

/**
 * The initial path the picker opens at. Patch A: the empty-string default made
 * `GET /fs/browse?path=` hit `fs::read_dir("")` → ENOENT → the picker showed
 * an error and the user was stuck (Select/Up disabled). Seed with the host
 * filesystem root instead — `fs::read_dir("C:\\")` / `fs::read_dir("/")`
 * succeed cross-platform, so the picker actually lists directories on first
 * open. Detect platform client-side (the existing `navigator.platform` pattern
 * from `NewProjectModal.tsx:40`); Windows uses the system drive root, POSIX
 * uses `/`.
 */
const INITIAL_PATH =
  typeof navigator !== 'undefined' && navigator.platform.startsWith('Win') ? 'C:\\' : '/'

interface PendingSelection {
  resolve: (result: IpcResult<string>) => void
}

/**
 * Whether `dirPath` is a UNC path. After normalization (`\\` → `//`), a UNC
 * path starts with `//` (e.g. `//server/share/foo`). UNC paths require a
 * double leading slash on rejoin so `fs::read_dir` on Windows resolves them
 * as absolute UNC paths rather than relative POSIX paths (Patch F).
 */
function isUnc(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized.startsWith('//')
}

/**
 * Compute the parent path of `dirPath`. Cross-platform: splits on both `/` and
 * `\`, drops the last non-empty segment, and re-joins with the original
 * separator(s). Returns `null` when `dirPath` is already a root (no parent),
 * so the picker can disable the "go up" affordance at the filesystem root.
 *
 * Examples:
 *   `C:\Users\foo`        -> `C:\Users`
 *   `C:\`                 -> null  (root)
 *   `/home/foo`           -> `/home`
 *   `/`                   -> null  (root)
 *   `` (empty)            -> null
 *   `\\server\share\foo`  -> `//server/share`  (UNC — double slash preserved)
 *   `\\server\share`      -> null  (UNC share root — no parent)
 */
function parentPath(dirPath: string): string | null {
  if (!dirPath) return null
  // Normalize backslashes to forward slashes for segmentation, then split.
  const normalized = dirPath.replace(/\\/g, '/')
  const segments = normalized.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return null
  // A Windows drive root like `C:` (from `C:/`) has no parent.
  if (segments.length === 1 && /^[a-zA-Z]:$/.test(segments[0])) return null
  const unc = isUnc(normalized)
  // UNC share root: `\\server\share` (segments: ['server','share']) — no
  // parent. Disable Up here (Patch F). Above the share root Windows
  // re-roots to the drive list; we treat the share root as the top.
  if (unc && segments.length === 2) return null
  // Drop the last segment to ascend one level.
  const parentSegments = segments.slice(0, -1)
  if (parentSegments.length === 0) {
    // Ascending from `/foo` -> `/` (POSIX root) — return root, not null, so
    // the user can browse root's children. Only the root itself returns null.
    return '/'
  }
  // Re-join. On Windows a bare drive root (`C:`) needs a trailing separator to
  // be a valid absolute path; for everything else (incl. `C:/Users`) a plain
  // join is correct — the server tolerates either separator.
  const joined = parentSegments.join('/')
  if (/^[a-zA-Z]:$/.test(parentSegments[0]) && parentSegments.length === 1) {
    // Ascending to the drive root, e.g. `C:\Users` -> `C:/`.
    return `${joined}/`
  }
  if (/^[a-zA-Z]:$/.test(parentSegments[0])) {
    // Windows drive path below the root, e.g. `C:\Users\foo` -> `C:/Users`.
    return joined
  }
  if (unc) {
    // Patch F: preserve the double-leading-slash on rejoin so Windows
    // resolves the result as an absolute UNC path. Single-slash would be a
    // relative POSIX path → wrong dir or READ_ERROR.
    return `//${joined}`
  }
  return `/${joined}`
}

/**
 * Append `child` (a directory name) to `dirPath`, producing the full path to
 * descend into. Uses the existing separator if present, otherwise `/`.
 */
function childPath(dirPath: string, childName: string): string {
  if (!dirPath) return childName
  const sep = dirPath.endsWith('/') || dirPath.endsWith('\\') ? '' : '/'
  return `${dirPath}${sep}${childName}`
}

/**
 * Derive the "current" directory path from a listing's entries. Each entry's
 * `path` is `<currentDir>/<name>`, so the current dir is the parent of any
 * entry's path. Returns `null` when entries is empty or the parent can't be
 * derived (e.g. entries at the filesystem root). Used when the picker opens
 * with no known path (the initial browse request is empty).
 */
function deriveCurrentFromEntries(entries: DirectoryEntry[]): string | null {
  for (const entry of entries) {
    const parent = parentPath(entry.path)
    if (parent !== null) return parent
  }
  return null
}

export function DirectoryPicker(): React.JSX.Element {
  // Desktop mode never mounts this component (see App.tsx), but guard anyway so
  // a misconfigured import is a no-op rather than a broken modal.
  const [isOpen, setIsOpen] = useState(false)
  const [currentPath, setCurrentPath] = useState<string>(INITIAL_PATH)
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingSelection | null>(null)

  // Patch K: a ref mirroring `currentPath` so the opener (registered ONCE on
  // mount with empty deps) can read the latest path without re-registering on
  // every navigation. The previous deps `[currentPath, loadPath]` re-registered
  // a fresh opener on each navigation and called `_resetWebDirectoryPickerForTesting`
  // in cleanup each time — leaving a microtask window where `selectDirectory()`
  // returned `CANCELLED` (webDirectoryPicker === null).
  const currentPathRef = useRef<string>(currentPath)
  currentPathRef.current = currentPath
  // Patch E: a ref mirroring `pending` so the mount-cleanup can resolve the
  // outstanding promise when the component unmounts mid-pick (e.g. hot-reload)
  // — otherwise `dialogApi.selectDirectory()` hangs forever.
  const pendingRef = useRef<PendingSelection | null>(pending)
  pendingRef.current = pending

  const loadPath = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    const result = await webServerDialog.browseDirectory(path)
    if (result.success && result.data) {
      // Directories only — files aren't selectable in a folder picker.
      const dirs = result.data.filter((e) => e.type === 'directory')
      setEntries(dirs)
      // Derive the "current" directory from the returned entries: each
      // entry.path is <currentDir>/<name>, so the current dir is the parent
      // of any entry's path. This is authoritative — the server tells us where
      // we actually are via the entry paths, regardless of whether the
      // requested path was empty (pre-Patch-A) or a root seed (Patch A:
      // `C:\` / `/`). Fall back to the requested path only when there are no
      // entries to derive from.
      const resolved = deriveCurrentFromEntries(dirs) || path
      setCurrentPath(resolved)
    } else {
      // Failure (missing dir, transport error): show empty listing + the error
      // message so the user understands why nothing is listed. Keep the path
      // so the "go up" / "select current" affordances still make sense.
      setEntries([])
      if (!result.success) {
        setError(result.error || 'Unable to list this directory')
      }
    }
    setLoading(false)
  }, [])

  // Patch K: register the opener ONCE at mount (empty deps). The opener reads
  // the latest `currentPath` via `currentPathRef` so it doesn't need to be a
  // dep — navigating no longer re-registers a fresh opener (which left a
  // microtask window where `selectDirectory()` returned CANCELLED).
  useEffect(() => {
    if (isTauriContext()) return // desktop never registers a web picker
    registerWebDirectoryPicker(async (): Promise<IpcResult<string>> => {
      return new Promise<IpcResult<string>>((resolve) => {
        setPending({ resolve })
        setIsOpen(true)
        // Load the initial listing when the picker opens. Read the latest
        // `currentPath` via the ref (so we don't re-register on each nav).
        const startPath = currentPathRef.current || INITIAL_PATH
        void loadPath(startPath)
      })
    })
    return () => {
      // Patch E: on unmount, if a pick is outstanding, resolve it with a
      // CANCELLED result BEFORE resetting the registration — otherwise the
      // `dialogApi.selectDirectory()` promise hangs forever (Browse appears
      // dead after hot-reload). Then drop the registration so a future mount
      // re-registers cleanly.
      const outstanding = pendingRef.current
      if (outstanding) {
        outstanding.resolve({
          success: false,
          error: 'Picker closed',
          code: 'CANCELLED'
        })
      }
      _resetWebDirectoryPickerForTesting()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPath])

  const close = useCallback(
    (result: IpcResult<string>) => {
      setIsOpen(false)
      setPending(null)
      // Reset navigation state for the next open.
      setEntries([])
      setError(null)
      setCurrentPath(INITIAL_PATH)
      pending?.resolve(result)
    },
    [pending]
  )

  const handleSelectCurrent = useCallback(() => {
    if (!currentPath) {
      close({ success: false, error: 'No directory selected', code: 'CANCELLED' })
      return
    }
    close({ success: true, data: currentPath })
  }, [currentPath, close])

  const handleCancel = useCallback(() => {
    close({ success: false, error: 'No directory selected', code: 'CANCELLED' })
  }, [close])

  const handleNavigateInto = useCallback(
    (entry: DirectoryEntry) => {
      // Prefer the server-provided full path; fall back to joining if absent.
      const next = entry.path || childPath(currentPath, entry.name)
      void loadPath(next)
    },
    [currentPath, loadPath]
  )

  const handleGoUp = useCallback(() => {
    const parent = parentPath(currentPath)
    if (parent === null) return
    void loadPath(parent)
  }, [currentPath, loadPath])

  // Escape to cancel (matches NewProjectModal / ConfirmDialog convention).
  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, handleCancel])

  const canGoUp = parentPath(currentPath) !== null

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center"
          onClick={handleCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-[560px] border border-border overflow-hidden max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50 flex-shrink-0">
              <h3 className="text-sm font-semibold text-foreground">Select Project Folder</h3>
              <button
                onClick={handleCancel}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Cancel directory picker"
              >
                <X size={14} />
              </button>
            </div>

            {/* Current path + go up */}
            <div className="px-4 py-2 border-b border-border bg-secondary/30 flex items-center gap-2 flex-shrink-0">
              <button
                onClick={handleGoUp}
                disabled={!canGoUp || loading}
                className={cn(
                  'flex items-center gap-1 text-xs px-2 py-1 rounded border border-border transition-colors',
                  canGoUp && !loading
                    ? 'text-foreground hover:bg-muted'
                    : 'text-muted-foreground/50 cursor-not-allowed'
                )}
                aria-label="Go up one directory"
              >
                <ArrowUp size={12} />
                <span>Up</span>
              </button>
              <div
                className="flex-1 text-xs font-mono text-muted-foreground truncate px-2 py-1 bg-background border border-border rounded"
                title={currentPath}
              >
                {currentPath || '(no path)'}
              </div>
            </div>

            {/* Listing */}
            <div className="flex-1 overflow-y-auto p-1 min-h-[200px]">
              {loading ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Listing directory...
                </div>
              ) : entries.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
                  {error ? error : 'No subdirectories in this folder'}
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        onClick={() => handleNavigateInto(entry)}
                        className={cn(
                          'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left transition-colors',
                          entry.ignored
                            ? 'text-muted-foreground/60 hover:bg-secondary/50'
                            : 'text-foreground hover:bg-secondary'
                        )}
                        title={entry.path}
                      >
                        <Folder
                          size={14}
                          className={entry.ignored ? 'text-muted-foreground/40' : 'text-primary/70'}
                        />
                        <span className="flex-1 truncate">{entry.name}</span>
                        <ChevronRight
                          size={12}
                          className="text-muted-foreground/50 flex-shrink-0"
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border flex-shrink-0">
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSelectCurrent}
                disabled={!currentPath}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded transition-all',
                  currentPath
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-md shadow-primary/20'
                    : 'bg-primary/50 text-primary-foreground/70 cursor-not-allowed'
                )}
              >
                Select Current Folder
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// Exported for unit tests so they can exercise the path helpers directly
// without mounting the component.
export const __testing = { parentPath, childPath, deriveCurrentFromEntries, isUnc }
