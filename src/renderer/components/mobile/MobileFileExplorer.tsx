import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  FilePlus,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { MaterialFileIcon } from '@/components/file-explorer/MaterialFileIcon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { filesystemApi, persistenceApi } from '@/lib/api'
import { sortDirectoryEntries } from '@/lib/filesystem-sort'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorer, useFileExplorerActions } from '@/stores/file-explorer-store'
import { useActiveProjectId } from '@/stores/project-store'
import { editorTabId, useWorkspaceStore } from '@/stores/workspace-store'

interface MobileFileExplorerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface CreateState {
  type: 'file' | 'directory'
  value: string
}

interface RenameState {
  path: string
  value: string
}

type NavigationDirection = -1 | 0 | 1

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized
  return normalized.replace(/\/+$/, '') || '/'
}

function pathIdentity(path: string): string {
  const normalized = normalizePath(path)
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '')
}

/** Case-insensitive comparison form of a path: `pathIdentity` lowercased.
 * Routed through every within-root comparison (`isWithinRoot`, `parentOf`,
 * `isAtRoot`, `navigateBack`) so a casing discrepancy between the stored
 * `rootPath` (config casing, e.g. `e:/proj`) and server-canonicalized entry
 * paths (on-disk casing, e.g. `E:/proj/...`) no longer clamps back
 * navigation to root. Never feeds the stored `currentPath` or any display
 * string — those keep the case-preserving `normalizePath` output. */
function comparePath(path: string): string {
  return pathIdentity(path).toLowerCase()
}

function joinPath(parent: string, name: string): string {
  return `${normalizePath(parent).replace(/\/$/, '')}/${name}`
}

function isWithinRoot(path: string, root: string): boolean {
  const p = comparePath(path)
  const r = comparePath(root)
  if (p === r) return true
  // Drive roots (`c:/`, lowercased from `C:/`) and posix `/` prefix any
  // child without a trailing separator, so check `startsWith(r)` directly
  // for those.
  if (r === '/' || /^[A-Za-z]:\/$/.test(r)) return p.startsWith(r)
  return p.startsWith(`${r}/`)
}

/** Lean touch-first file explorer drawer for the web/mobile view. Directory
 * rows drill into a single folder at a time, while files reuse the desktop
 * open-file wiring. Native desktop keeps its existing tree explorer. */
export function MobileFileExplorer({
  open,
  onOpenChange
}: MobileFileExplorerProps): React.JSX.Element {
  const { rootPath, directoryContents, loadingDirs, rootLoadError } = useFileExplorer()
  const { toggleDirectory, refreshDirectory, selectPath } = useFileExplorerActions()
  const reducedMotion = useReducedMotion() ?? false
  const projectId = useActiveProjectId()

  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [navigationDirection, setNavigationDirection] = useState<NavigationDirection>(0)
  const [actionEntry, setActionEntry] = useState<DirectoryEntry | null>(null)
  const [renaming, setRenaming] = useState<RenameState | null>(null)
  const [creating, setCreating] = useState<CreateState | null>(null)
  const [createSubmitting, setCreateSubmitting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<DirectoryEntry | null>(null)
  // Tracks the project root we've already restored the persisted folder for.
  // Prevents re-reading persistence (and clobbering the in-session folder) on
  // every drawer reopen — the component stays mounted across close, so
  // currentPath already holds the user's last folder.
  const restoredForRootRef = useRef<string | null>(null)

  function persistFolder(path: string): void {
    if (!projectId) return
    void persistenceApi.write(PersistenceKeys.mobileFileExplorerFolder(projectId), path)
  }

  // Restore the last folder the user navigated into (persisted per project)
  // when opening for a new/different project root — first open, reload, or
  // project switch. Within-session reopens keep the current folder: the
  // component stays mounted across drawer close, so currentPath survives.
  useEffect(() => {
    if (!open) return
    setNavigationDirection(0)
    setActionEntry(null)
    setRenaming(null)
    setCreating(null)
    if (!rootPath) {
      setCurrentPath(null)
      return
    }
    const restoreKey = `${projectId ?? ''}:${rootPath}`
    if (restoredForRootRef.current === restoreKey) return
    restoredForRootRef.current = restoreKey
    const normalizedRoot = normalizePath(rootPath)
    if (!projectId) {
      setCurrentPath(normalizedRoot)
      return
    }
    // Clear a stale folder from a different project while reading the
    // persisted one, so the drawer shows loading instead of old contents.
    setCurrentPath(null)
    // Cancel the pending read if rootPath/projectId change mid-flight, so a
    // late resolution can't apply the previous project's folder; fall back to
    // root on rejection (persistenceApi.read shouldn't reject, but defend it).
    let cancelled = false
    void persistenceApi
      .read<string>(PersistenceKeys.mobileFileExplorerFolder(projectId))
      .then((res) => {
        if (cancelled) return
        const persisted = res.success ? res.data : null
        setCurrentPath(persisted && isWithinRoot(persisted, rootPath) ? persisted : normalizedRoot)
      })
      .catch(() => {
        if (!cancelled) setCurrentPath(normalizedRoot)
      })
    return () => {
      cancelled = true
    }
  }, [open, rootPath, projectId])

  // Web has no directory watcher, so load whichever folder is currently shown.
  useEffect(() => {
    if (!open || !currentPath) return
    if (!directoryContents.has(currentPath) && !loadingDirs.has(currentPath)) {
      void toggleDirectory(currentPath)
    }
  }, [open, currentPath, directoryContents, loadingDirs, toggleDirectory])

  function parentOf(path: string): string {
    const normalized = normalizePath(path)
    const canonicalRoot = rootPath ? normalizePath(rootPath) : normalized
    const rootCompare = comparePath(canonicalRoot)
    const currentCompare = comparePath(normalized)
    const rootPrefix = rootCompare === '/' ? '/' : `${rootCompare}/`
    if (currentCompare === rootCompare || !currentCompare.startsWith(rootPrefix)) {
      return canonicalRoot
    }
    const parent = normalized.slice(0, normalized.lastIndexOf('/'))
    return comparePath(parent) === rootCompare ? canonicalRoot : parent
  }

  function closeAffectedTabs(target: DirectoryEntry): void {
    const editor = useEditorStore.getState()
    const targetNorm = normalizePath(target.path)
    const prefix = `${targetNorm}/`
    for (const openPath of Array.from(editor.openFiles.keys())) {
      const openNorm = normalizePath(openPath)
      if (openNorm === targetNorm || (target.type === 'directory' && openNorm.startsWith(prefix))) {
        editor.closeFile(openPath)
        useWorkspaceStore.getState().removeTab(editorTabId(openPath))
      }
    }
  }

  async function handleOpenFile(entry: DirectoryEntry): Promise<void> {
    selectPath(entry.path)
    try {
      await useEditorStore.getState().openFile(entry.path)
      useWorkspaceStore.getState().addEditorTab(entry.path)
      onOpenChange(false)
    } catch (error) {
      toast.error('Failed to open file', {
        description: error instanceof Error ? error.message : String(error)
      })
    }
  }

  function navigateForward(path: string): void {
    setCreating(null)
    setRenaming(null)
    setNavigationDirection(1)
    const next = normalizePath(path)
    setCurrentPath(next)
    persistFolder(next)
  }

  function navigateBack(): void {
    if (!currentPath || !rootPath || comparePath(currentPath) === comparePath(rootPath)) return
    setCreating(null)
    setRenaming(null)
    setNavigationDirection(-1)
    const next = parentOf(currentPath)
    setCurrentPath(next)
    persistFolder(next)
  }

  function handleRowTap(entry: DirectoryEntry): void {
    if (renaming?.path === entry.path) return
    if (entry.type === 'directory') navigateForward(entry.path)
    else void handleOpenFile(entry)
  }

  async function handleCreate(): Promise<void> {
    if (!creating || !currentPath || createSubmitting) return
    const name = creating.value.trim()
    if (!name) return
    const submittedPath = currentPath
    const fullPath = joinPath(submittedPath, name)
    setCreateSubmitting(true)
    try {
      const result =
        creating.type === 'file'
          ? await filesystemApi.createFile(fullPath)
          : await filesystemApi.createDirectory(fullPath)
      if (!result.success) {
        toast.error('Failed to create', { description: result.error })
        return
      }
      setCreating(null)
      await refreshDirectory(submittedPath)
    } finally {
      setCreateSubmitting(false)
    }
  }

  async function handleRename(entry: DirectoryEntry, value: string): Promise<void> {
    const name = value.trim()
    if (!name || !renaming) {
      setRenaming(null)
      return
    }
    const parent = parentOf(entry.path)
    const newPath = joinPath(parent, name)
    if (normalizePath(newPath) === normalizePath(entry.path)) {
      setRenaming(null)
      return
    }
    setRenaming(null)
    const result = await filesystemApi.renameFile(entry.path, newPath)
    if (!result.success) {
      toast.error('Failed to rename', { description: result.error })
      return
    }
    closeAffectedTabs(entry)
    if (currentPath && normalizePath(currentPath).startsWith(`${normalizePath(entry.path)}/`)) {
      setCurrentPath(parent)
      setNavigationDirection(-1)
      persistFolder(parent)
    }
    await refreshDirectory(parent)
  }

  async function handleDelete(entry: DirectoryEntry): Promise<void> {
    const result = await filesystemApi.deletePath(entry.path, {
      recursive: entry.type === 'directory'
    })
    if (!result.success) {
      toast.error('Failed to delete', { description: result.error })
      return
    }
    closeAffectedTabs(entry)
    const parent = parentOf(entry.path)
    if (
      currentPath &&
      (normalizePath(currentPath) === normalizePath(entry.path) ||
        normalizePath(currentPath).startsWith(`${normalizePath(entry.path)}/`))
    ) {
      setCurrentPath(parent)
      setNavigationDirection(-1)
      persistFolder(parent)
    }
    await refreshDirectory(parent)
  }

  async function handleDuplicate(entry: DirectoryEntry): Promise<void> {
    const dot = entry.name.lastIndexOf('.')
    const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name
    const ext = dot > 0 ? entry.name.slice(dot) : ''
    const parent = parentOf(entry.path)
    const result = await filesystemApi.copyFile(entry.path, joinPath(parent, `${stem} copy${ext}`))
    if (!result.success) {
      toast.error('Failed to copy', { description: result.error })
      return
    }
    await refreshDirectory(parent)
  }

  function renderRow(entry: DirectoryEntry): React.ReactNode {
    const isRenaming = renaming?.path === entry.path
    return (
      <li key={entry.path}>
        {isRenaming ? (
          <Input
            autoFocus
            defaultValue={renaming.value}
            onChange={(event) => setRenaming({ path: entry.path, value: event.target.value })}
            onBlur={() => void handleRename(entry, renaming.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleRename(entry, renaming.value)
              if (event.key === 'Escape') setRenaming(null)
            }}
            className="m-1 h-11"
            aria-label={`Rename ${entry.name}`}
          />
        ) : (
          <div className="flex h-11 items-center gap-2 px-2">
            <button
              type="button"
              className="flex h-11 min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => handleRowTap(entry)}
              aria-label={
                entry.type === 'directory' ? `Open folder ${entry.name}` : `Open ${entry.name}`
              }
            >
              <MaterialFileIcon
                name={entry.name}
                extension={entry.extension}
                isDirectory={entry.type === 'directory'}
                isExpanded={false}
                depth={0}
                size={18}
              />
              <span
                className={`min-w-0 flex-1 truncate text-sm ${entry.ignored ? 'text-muted-foreground' : 'text-foreground'}`}
              >
                {entry.name}
              </span>
              {entry.type === 'directory' && (
                <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
              )}
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0"
              aria-label={`Actions for ${entry.name}`}
              onClick={(event) => {
                event.stopPropagation()
                setActionEntry(entry)
              }}
            >
              <MoreHorizontal size={18} />
            </Button>
          </div>
        )}
      </li>
    )
  }

  const normalizedRoot = rootPath ? normalizePath(rootPath) : null
  const normalizedCurrent = currentPath ? normalizePath(currentPath) : null
  // Roots ending in a separator (`/`, `C:/`) already include it, so the
  // relative-path label slices from the root length itself; otherwise skip the
  // separator after the root (the old `+ 1` dropped the first child char for
  // `C:/`/`/`).
  const rootPrefixLength = normalizedRoot
    ? normalizedRoot.endsWith('/')
      ? normalizedRoot.length
      : normalizedRoot.length + 1
    : 0
  const isAtRoot =
    !normalizedRoot || comparePath(normalizedCurrent ?? '/') === comparePath(normalizedRoot)
  const currentName =
    normalizedCurrent && normalizedRoot
      ? isAtRoot
        ? normalizedRoot.split('/').filter(Boolean).at(-1) || normalizedRoot
        : normalizedCurrent.split('/').filter(Boolean).at(-1) || normalizedCurrent
      : 'Files'
  const currentEntries = currentPath
    ? sortDirectoryEntries(directoryContents.get(currentPath) ?? [])
    : []
  const isCurrentLoading = !!currentPath && loadingDirs.has(currentPath)
  const slideDistance = reducedMotion ? 0 : 28

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-[min(100vw,26rem)] flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="space-y-0 border-b border-border/60 px-3 py-3 text-left">
          <div className="flex min-w-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-ml-2 size-9 shrink-0"
              aria-label="Back to parent folder"
              disabled={isAtRoot || createSubmitting}
              onClick={navigateBack}
            >
              <ChevronLeft size={19} />
            </Button>
            <div className="min-w-0">
              <SheetTitle className="truncate text-base">{currentName}</SheetTitle>
              <p
                className="truncate text-xs text-muted-foreground"
                title={normalizedCurrent ?? undefined}
              >
                {isAtRoot ? 'Project files' : normalizedCurrent?.slice(rootPrefixLength)}
              </p>
            </div>
          </div>
          <SheetDescription className="sr-only">Browse project files</SheetDescription>
        </SheetHeader>

        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="Refresh current folder"
            disabled={!currentPath || createSubmitting}
            onClick={() => currentPath && void refreshDirectory(currentPath)}
          >
            <RefreshCw size={16} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="New file"
            disabled={!currentPath || createSubmitting}
            onClick={() => setCreating({ type: 'file', value: '' })}
          >
            <FilePlus size={16} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="New folder"
            disabled={!currentPath || createSubmitting}
            onClick={() => setCreating({ type: 'directory', value: '' })}
          >
            <FolderPlus size={16} />
          </Button>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {rootLoadError && isAtRoot ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">{rootLoadError.message}</p>
              {currentPath && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void refreshDirectory(currentPath)}
                >
                  Retry
                </Button>
              )}
            </div>
          ) : !currentPath ? (
            rootPath ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</div>
            ) : (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No active project
              </div>
            )
          ) : (
            <AnimatePresence initial={false} mode="wait" custom={navigationDirection}>
              <motion.div
                key={currentPath}
                custom={navigationDirection}
                data-testid="mobile-folder-view"
                data-navigation-direction={
                  navigationDirection === 1
                    ? 'forward'
                    : navigationDirection === -1
                      ? 'back'
                      : 'none'
                }
                data-reduced-motion={reducedMotion ? 'true' : 'false'}
                className="absolute inset-0 overflow-y-auto py-1"
                initial={{ opacity: reducedMotion ? 1 : 0, x: navigationDirection * slideDistance }}
                animate={{ opacity: 1, x: 0 }}
                exit={{
                  opacity: reducedMotion ? 1 : 0,
                  x: navigationDirection * -slideDistance
                }}
                transition={{ duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' }}
              >
                {creating ? (
                  <div className="px-2 py-1">
                    <Input
                      autoFocus
                      disabled={createSubmitting}
                      placeholder={creating.type === 'file' ? 'new-file.txt' : 'new-folder'}
                      onChange={(event) => setCreating({ ...creating, value: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void handleCreate()
                        if (event.key === 'Escape') setCreating(null)
                      }}
                      className="h-11"
                      aria-label={creating.type === 'file' ? 'New file name' : 'New folder name'}
                    />
                  </div>
                ) : isCurrentLoading && !directoryContents.has(currentPath) ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    Loading…
                  </div>
                ) : currentEntries.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">Empty</div>
                ) : (
                  <ul aria-label={`Files in ${currentName}`}>{currentEntries.map(renderRow)}</ul>
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </div>

        <Sheet open={!!actionEntry} onOpenChange={(value) => !value && setActionEntry(null)}>
          <SheetContent
            side="bottom"
            className="flex flex-col gap-0 rounded-t-xl p-2"
            aria-label={actionEntry ? `Actions for ${actionEntry.name}` : undefined}
          >
            {actionEntry && (
              <>
                <SheetHeader className="px-3 py-2 text-left">
                  <SheetTitle className="truncate text-sm">{actionEntry.name}</SheetTitle>
                </SheetHeader>
                <button
                  type="button"
                  className="flex h-11 items-center gap-3 rounded-md px-3 text-sm hover:bg-accent"
                  onClick={() => {
                    setRenaming({ path: actionEntry.path, value: actionEntry.name })
                    setActionEntry(null)
                  }}
                >
                  <Pencil size={16} /> Rename
                </button>
                <button
                  type="button"
                  className="flex h-11 items-center gap-3 rounded-md px-3 text-sm hover:bg-accent"
                  onClick={() => {
                    const entry = actionEntry
                    setActionEntry(null)
                    void handleDuplicate(entry)
                  }}
                >
                  <Copy size={16} /> Duplicate
                </button>
                <button
                  type="button"
                  className="flex h-11 items-center gap-3 rounded-md px-3 text-sm text-destructive hover:bg-accent"
                  onClick={() => {
                    setPendingDelete(actionEntry)
                    setActionEntry(null)
                  }}
                >
                  <Trash2 size={16} /> Delete
                </button>
              </>
            )}
          </SheetContent>
        </Sheet>
      </SheetContent>

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name ?? ''}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.type === 'directory'
                ? 'This will delete the folder and all its contents. This cannot be undone.'
                : 'This will delete the file. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 text-white hover:bg-red-600"
              onClick={() => {
                if (pendingDelete) void handleDelete(pendingDelete)
                setPendingDelete(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}
