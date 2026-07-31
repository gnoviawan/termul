import type { DirectoryEntry } from '@shared/types/filesystem.types'
import {
  ChevronRight,
  Copy,
  FilePlus,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { useEffect, useState } from 'react'
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
import { filesystemApi } from '@/lib/api'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorer, useFileExplorerActions } from '@/stores/file-explorer-store'
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

/** Lean touch-first file explorer drawer for the web/mobile view. Reuses the
 * shared `file-explorer-store` (browse/select/toggle/refresh) + the
 * `MaterialFileIcon` primitive, but renders its own tall, full-width tap
 * targets (no drag-drop/context-menu/keyboard-shortcuts/resize — those stay
 * desktop). Tapping a file reuses the desktop open-file wiring
 * (`selectPath` → `editorStore.openFile` → `workspaceStore.addEditorTab`) so
 * files open in the existing editor tab in the mobile pane tree, identical to
 * desktop double-click. Gated to `!isTauriContext()` by the caller
 * (`MobileChatShell`). v1 has no live watchers (web re-fetches on
 * action/refresh) and no streaming search. */
export function MobileFileExplorer({
  open,
  onOpenChange
}: MobileFileExplorerProps): React.JSX.Element {
  const { rootPath, directoryContents, expandedDirs, loadingDirs, rootLoadError } =
    useFileExplorer()
  const { toggleDirectory, refreshDirectory, selectPath, collapseAll } = useFileExplorerActions()

  const [actionEntry, setActionEntry] = useState<DirectoryEntry | null>(null)
  const [renaming, setRenaming] = useState<RenameState | null>(null)
  const [creating, setCreating] = useState<CreateState | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DirectoryEntry | null>(null)

  // Load the root listing when the drawer opens (web has no watchers, so the
  // store is not pre-populated by the workspace layout's watch effect).
  useEffect(() => {
    if (!open || !rootPath) return
    if (!directoryContents.has(rootPath) && !loadingDirs.has(rootPath)) {
      void toggleDirectory(rootPath)
    }
  }, [open, rootPath, directoryContents, loadingDirs, toggleDirectory])

  function parentOf(path: string): string {
    const normalized = path.replace(/\\/g, '/')
    const idx = normalized.lastIndexOf('/')
    return idx <= 0 ? (rootPath ?? normalized) : normalized.slice(0, idx)
  }

  /** Close every open editor tab pointing at `target` — the exact path for a
   * file, or the path plus any descendant for a directory (a recursive
   * delete or a directory rename moves/removes them all). Keeps the mobile
   * pane tree free of stale/orphan tabs, mirroring desktop FileExplorer's
   * reconciliation but covering the recursive directory case the exact-match
   * check missed. */
  function closeAffectedTabs(target: DirectoryEntry): void {
    const editor = useEditorStore.getState()
    const targetNorm = target.path.replace(/\\/g, '/')
    const prefix = `${targetNorm}/`
    for (const openPath of Array.from(editor.openFiles.keys())) {
      const openNorm = openPath.replace(/\\/g, '/')
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

  function handleRowTap(entry: DirectoryEntry): void {
    if (renaming?.path === entry.path) return
    if (entry.type === 'directory') {
      void toggleDirectory(entry.path)
    } else {
      void handleOpenFile(entry)
    }
  }

  async function handleCreate(): Promise<void> {
    if (!creating || !rootPath) return
    const name = creating.value.trim()
    if (!name) return
    const fullPath = `${rootPath.replace(/\\/g, '/')}/${name}`
    const result =
      creating.type === 'file'
        ? await filesystemApi.createFile(fullPath)
        : await filesystemApi.createDirectory(fullPath)
    if (!result.success) {
      toast.error('Failed to create', { description: result.error })
      return
    }
    setCreating(null)
    await refreshDirectory(rootPath)
  }

  async function handleRename(entry: DirectoryEntry, value: string): Promise<void> {
    const name = value.trim()
    if (!name || !renaming) {
      setRenaming(null)
      return
    }
    const parent = parentOf(entry.path)
    const newPath = `${parent.replace(/\\/g, '/')}/${name}`
    if (newPath === entry.path) {
      setRenaming(null)
      return
    }
    // Clear the rename state BEFORE the async request so an Enter→blur
    // sequence can't fire `handleRename` twice — the second call would hit a
    // missing source (already renamed) and surface a spurious "Failed to
    // rename" toast after a successful rename. With state cleared up front,
    // a late blur re-enters `handleRename`, sees `renaming === null`, and
    // returns early via the guard above.
    setRenaming(null)
    const result = await filesystemApi.renameFile(entry.path, newPath)
    if (!result.success) {
      toast.error('Failed to rename', { description: result.error })
      return
    }
    // Reconcile open editor tabs: close tabs pointing at the old path (and,
    // for a renamed directory, its descendants) so the mobile pane tree never
    // shows a stale/orphan path.
    closeAffectedTabs(entry)
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
    // Close tabs pointing at the deleted path — the exact path for a file,
    // or the path plus any descendant for a recursive directory delete.
    closeAffectedTabs(entry)
    await refreshDirectory(parentOf(entry.path))
  }

  async function handleDuplicate(entry: DirectoryEntry): Promise<void> {
    const dot = entry.name.lastIndexOf('.')
    const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name
    const ext = dot > 0 ? entry.name.slice(dot) : ''
    const dest = `${parentOf(entry.path).replace(/\\/g, '/')}/${stem} copy${ext}`
    const result = await filesystemApi.copyFile(entry.path, dest)
    if (!result.success) {
      toast.error('Failed to copy', { description: result.error })
      return
    }
    await refreshDirectory(parentOf(entry.path))
  }

  function renderRow(entry: DirectoryEntry, depth: number): React.ReactNode {
    const isExpanded = expandedDirs.has(entry.path)
    const isRenaming = renaming?.path === entry.path
    const isLoading = loadingDirs.has(entry.path)
    return (
      <div
        key={entry.path}
        role="treeitem"
        tabIndex={-1}
        aria-expanded={entry.type === 'directory' ? isExpanded : undefined}
      >
        {isRenaming ? (
          <Input
            autoFocus
            defaultValue={renaming.value}
            onChange={(e) => setRenaming({ path: entry.path, value: e.target.value })}
            onBlur={() => void handleRename(entry, renaming.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRename(entry, renaming.value)
              if (e.key === 'Escape') setRenaming(null)
            }}
            className="m-1 h-11"
            aria-label={`Rename ${entry.name}`}
          />
        ) : (
          <div
            className="flex h-11 items-center gap-2 px-2"
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
          >
            <button
              type="button"
              className="flex h-11 min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => handleRowTap(entry)}
              aria-label={
                entry.type === 'directory'
                  ? `${isExpanded ? 'Collapse' : 'Expand'} ${entry.name}`
                  : `Open ${entry.name}`
              }
            >
              <MaterialFileIcon
                name={entry.name}
                extension={entry.extension}
                isDirectory={entry.type === 'directory'}
                isExpanded={isExpanded}
                depth={depth}
                size={18}
              />
              <span
                className={`min-w-0 flex-1 truncate text-sm ${entry.ignored ? 'text-muted-foreground' : 'text-foreground'}`}
              >
                {entry.name}
              </span>
              {entry.type === 'directory' && (
                <ChevronRight
                  size={16}
                  className={`shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                />
              )}
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0"
              aria-label={`Actions for ${entry.name}`}
              onClick={(e) => {
                e.stopPropagation()
                setActionEntry(entry)
              }}
            >
              <MoreHorizontal size={18} />
            </Button>
          </div>
        )}
        {entry.type === 'directory' && isExpanded && (
          // biome-ignore lint/a11y/useSemanticElements: ARIA tree pattern groups a treeitem's expanded children under role="group"; <fieldset> is a form-grouping element, not appropriate for tree structure
          <div role="group">
            {renderEntries(entry.path, depth + 1)}
            {isLoading && !directoryContents.has(entry.path) && (
              <div className="px-4 py-2 text-xs text-muted-foreground">Loading…</div>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderEntries(dirPath: string, depth: number): React.ReactNode {
    const entries = directoryContents.get(dirPath)
    if (!entries) return null
    if (entries.length === 0) {
      return (
        <div
          className="px-4 py-2 text-xs text-muted-foreground"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          Empty
        </div>
      )
    }
    return entries.map((entry) => renderRow(entry, depth))
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-[min(100vw,26rem)] flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="space-y-0 border-b border-border/60 px-3 py-3 text-left">
          <SheetTitle className="text-base">Files</SheetTitle>
          <SheetDescription className="sr-only">Browse project files</SheetDescription>
        </SheetHeader>

        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="Refresh"
            disabled={!rootPath}
            onClick={() => rootPath && void refreshDirectory(rootPath)}
          >
            <RefreshCw size={16} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="New file"
            disabled={!rootPath}
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
            disabled={!rootPath}
            onClick={() => setCreating({ type: 'directory', value: '' })}
          >
            <FolderPlus size={16} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto size-9"
            aria-label="Collapse all"
            disabled={!rootPath}
            onClick={() => collapseAll()}
          >
            <span className="text-xs">Collapse</span>
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {rootLoadError ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">{rootLoadError.message}</p>
              {rootPath && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void refreshDirectory(rootPath)}
                >
                  Retry
                </Button>
              )}
            </div>
          ) : creating ? (
            <div className="px-2 py-1">
              <Input
                autoFocus
                placeholder={creating.type === 'file' ? 'new-file.txt' : 'new-folder'}
                onChange={(e) => setCreating({ ...creating, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreate()
                  if (e.key === 'Escape') setCreating(null)
                }}
                className="h-11"
                aria-label={creating.type === 'file' ? 'New file name' : 'New folder name'}
              />
            </div>
          ) : !rootPath ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No active project
            </div>
          ) : (
            <div role="tree">{renderEntries(rootPath, 0)}</div>
          )}
        </div>

        {/* Action sheet (bottom) for the selected row. */}
        <Sheet open={!!actionEntry} onOpenChange={(v) => !v && setActionEntry(null)}>
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
                    const e = actionEntry
                    setActionEntry(null)
                    void handleDuplicate(e)
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
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
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
