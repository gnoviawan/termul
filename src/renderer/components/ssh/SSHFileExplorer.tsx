import type { SFTPEntry } from '@shared/types/ssh.types'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Upload } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { useAttachmentDropZone } from '@/hooks/use-attachment-drop-zone'
import { joinPath, parentPath, useSftpBrowser } from '@/hooks/use-sftp-browser'
import { useSftpTransfers } from '@/hooks/use-sftp-transfers'
import { sshApi } from '@/lib/api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useSSHActions, useSSHStore } from '@/stores/ssh-store'
import { SftpBreadcrumb } from './sftp/SftpBreadcrumb'
import { SftpDetailsFooter } from './sftp/SftpDetailsFooter'
import { SftpDropOverlay } from './sftp/SftpDropOverlay'
import {
  SFTP_MODIFIED_COL_CLASS,
  SFTP_NAME_INSET_CLASS,
  SFTP_SIZE_COL_CLASS,
  SftpEntryRow
} from './sftp/SftpEntryRow'
import { SftpToolbar } from './sftp/SftpToolbar'
import { SftpTransferTray } from './sftp/SftpTransferTray'

interface SSHFileExplorerProps {
  /** Backend id of the connected session whose files are shown */
  connectionId: string
  profileName: string
}

type NameDialog = { kind: 'folder' } | { kind: 'file' } | { kind: 'rename'; entry: SFTPEntry }

function validName(name: string): string | null {
  if (!name.trim()) return 'Enter a name.'
  if (name.includes('/')) return 'A name cannot contain “/”.'
  if (name === '.' || name === '..') return 'Choose a different name.'
  return null
}

/** Files dragged in from the OS; internal drags (tabs, rows) carry other types. */
function hasOsFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/** “a”, “a” and “b”, “a”, “b” and 3 more */
function nameList(names: string[]): string {
  const quoted = names.map((n) => `“${n}”`)
  if (quoted.length <= 2) return quoted.join(' and ')
  if (quoted.length === 3) return `${quoted[0]}, ${quoted[1]} and ${quoted[2]}`
  return `${quoted[0]}, ${quoted[1]} and ${quoted.length - 2} more`
}

/** Remote file browser for the active session (SFTP over its connection). */
export function SSHFileExplorer({
  connectionId,
  profileName
}: SSHFileExplorerProps): React.JSX.Element {
  const browser = useSftpBrowser(connectionId)
  const { setEditingFile, setEditingContent } = useSSHActions()
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null)
  const [nameValue, setNameValue] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteEntry, setDeleteEntry] = useState<SFTPEntry | null>(null)
  /** The entry in the details footer: the row focused last (click or keyboard). */
  const [focusedEntry, setFocusedEntry] = useState<SFTPEntry | null>(null)
  const nameId = useId()
  const desktop = isTauriContext()
  // Only the latest open may land in the editor (a slow read can finish last).
  const openRequest = useRef(0)

  const { currentPath, refresh, expandedDirs, reloadChildren } = browser
  const onUploaded = useCallback(
    (dir: string) => {
      // Only a listing of the folder the files went to needs refreshing; an
      // expanded subfolder reloads in place so the tree stays open.
      if (dir === currentPath) refresh()
      else if (expandedDirs.has(dir)) void reloadChildren(dir)
    },
    [currentPath, refresh, expandedDirs, reloadChildren]
  )
  const transfers = useSftpTransfers(connectionId, { onUploaded })

  // A new folder listing replaces the entries the footer could describe.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the folder changes
  useEffect(() => {
    setFocusedEntry(null)
  }, [currentPath])

  /** Unsaved edits in the open file block replacing it (asked again after the read). */
  const blockedByUnsavedEdits = (entry: SFTPEntry): boolean => {
    const { editingFile, editingContent } = useSSHStore.getState()
    if (!editingFile || editingContent === editingFile.originalContent) return false
    if (editingFile.path !== entry.path) {
      toast.error(`Save or discard your changes to ${editingFile.name} first.`)
    }
    return true
  }

  const openFile = async (entry: SFTPEntry) => {
    // Never drop unsaved edits by opening another file over them.
    if (blockedByUnsavedEdits(entry)) return
    const request = ++openRequest.current
    const result = await sshApi.sftpReadFile(connectionId, entry.path)
    if (request !== openRequest.current) return
    // Edits may have started while the file loaded.
    if (blockedByUnsavedEdits(entry)) return
    if (!result.success) {
      toast.error(`Couldn't open ${entry.name}: ${result.error}`)
      return
    }
    setEditingFile({
      connectionId,
      path: entry.path,
      name: entry.name,
      content: result.data,
      originalContent: result.data
    })
    setEditingContent(result.data)
  }

  const showNameDialog = (dialog: NameDialog) => {
    setNameDialog(dialog)
    setNameValue(dialog.kind === 'rename' ? dialog.entry.name : '')
    setNameError(null)
  }

  const submitName = async () => {
    if (!nameDialog || !browser.currentPath) return
    const problem = validName(nameValue)
    if (problem) {
      setNameError(problem)
      return
    }
    const name = nameValue.trim()
    setBusy(true)
    try {
      const result =
        nameDialog.kind === 'rename'
          ? await sshApi.sftpRename(
              connectionId,
              nameDialog.entry.path,
              joinPath(parentPath(nameDialog.entry.path), name)
            )
          : nameDialog.kind === 'folder'
            ? await sshApi.sftpMkdir(connectionId, joinPath(browser.currentPath, name))
            : await sshApi.sftpCreateFile(connectionId, joinPath(browser.currentPath, name))
      if (!result.success) {
        setNameError(result.error)
        return
      }
      setNameDialog(null)
      browser.refresh()
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    const entry = deleteEntry
    setDeleteEntry(null)
    if (!entry) return
    const result = await sshApi.sftpDelete(connectionId, entry.path)
    if (result.success) {
      toast.success(`Deleted ${entry.name}`)
      browser.refresh()
    } else {
      toast.error(`Couldn't delete ${entry.name}: ${result.error}`)
    }
  }

  // Upload needs local file paths, which only the desktop app has.
  const upload = desktop
    ? () => {
        if (browser.currentPath) void transfers.upload(browser.currentPath, browser.entries)
      }
    : undefined

  /** Names in `dir`, for the replace check: from the tree when loaded, else asked for. */
  const listingFor = async (dir: string): Promise<SFTPEntry[] | null> => {
    if (dir === currentPath) return browser.entries
    const loaded = browser.childEntries.get(dir)
    if (loaded) return loaded
    const result = await sshApi.sftpListDir(connectionId, dir)
    if (result.success) return result.data
    toast.error(`Couldn't check ${dir} before uploading: ${result.error}`)
    return null
  }

  // Dropping files from the OS uploads them into the open folder, or into the
  // folder row they are dropped on (desktop only). The row's drop runs first
  // and leaves its path here; the panel's drop then uploads.
  const canDropFiles = desktop && Boolean(currentPath)
  const [dropRow, setDropRow] = useState<string | null>(null)
  const dropRowRef = useRef<string | null>(null)
  const { dragActive, dropProps } = useAttachmentDropZone({
    canDropPaste: canDropFiles,
    addFiles: async (files) => {
      const dir = dropRowRef.current ?? currentPath
      dropRowRef.current = null
      setDropRow(null)
      if (!dir) return
      const listing = await listingFor(dir)
      if (listing) await transfers.uploadFiles(dir, listing, Array.from(files))
    }
  })
  // The drag left the panel (or ended): no folder row is targeted any more.
  useEffect(() => {
    if (!dragActive) setDropRow(null)
  }, [dragActive])

  const folderDropHandlers = (path: string) =>
    canDropFiles
      ? {
          onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
            if (!hasOsFiles(e)) return
            e.preventDefault()
            if (dropRow !== path) setDropRow(path)
          },
          onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
            if (!hasOsFiles(e)) return
            if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) {
              return
            }
            setDropRow((current) => (current === path ? null : current))
          },
          onDrop: (e: React.DragEvent<HTMLDivElement>) => {
            if (hasOsFiles(e)) dropRowRef.current = path
          }
        }
      : undefined

  const renderEntry = (entry: SFTPEntry, depth = 0): React.JSX.Element => {
    const isDir = entry.entryType === 'directory'
    const expanded = browser.expandedDirs.has(entry.path)
    const children = browser.childEntries.get(entry.path) ?? []
    return (
      <li key={entry.path}>
        <SftpEntryRow
          entry={entry}
          depth={depth}
          expanded={expanded}
          loading={browser.loadingDirs.has(entry.path)}
          focused={focusedEntry?.path === entry.path}
          onActivate={() =>
            isDir ? void browser.toggleDirectory(entry.path) : void openFile(entry)
          }
          onFocus={() => setFocusedEntry(entry)}
          onDownload={
            desktop && entry.entryType === 'file' ? () => void transfers.download(entry) : undefined
          }
          onRename={() => showNameDialog({ kind: 'rename', entry })}
          onDelete={() => setDeleteEntry(entry)}
          dropHandlers={isDir ? folderDropHandlers(entry.path) : undefined}
          dropTarget={isDir && dropRow === entry.path}
        />
        {isDir && expanded && children.length > 0 && (
          <ul>{children.map((child) => renderEntry(child, depth + 1))}</ul>
        )}
      </li>
    )
  }

  const replace = transfers.pendingReplace
  const replaceCount = replace?.conflicts.length ?? 0

  return (
    <section className="flex h-full w-full flex-col" aria-label={`Files on ${profileName}`}>
      <SftpToolbar
        hasPath={Boolean(browser.currentPath)}
        atRoot={browser.currentPath === '/'}
        onUp={() =>
          browser.currentPath && void browser.loadDirectory(parentPath(browser.currentPath))
        }
        onRefresh={browser.refresh}
        onNewFolder={() => showNameDialog({ kind: 'folder' })}
        onNewFile={() => showNameDialog({ kind: 'file' })}
        onUpload={upload}
      />

      {browser.currentPath && (
        <SftpBreadcrumb
          path={browser.currentPath}
          onNavigate={(path) => void browser.loadDirectory(path)}
        />
      )}

      {/* Drop zone: list, transfers and details. Handlers only react to OS files. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is pointer-only; the Upload button is the keyboard and screen-reader path */}
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        data-testid="sftp-drop-zone"
        onDragEnter={(e) => {
          if (hasOsFiles(e)) dropProps.onDragEnter()
        }}
        onDragLeave={(e) => {
          if (hasOsFiles(e)) dropProps.onDragLeave()
        }}
        onDragOver={(e) => {
          if (hasOsFiles(e)) dropProps.onDragOver?.(e)
        }}
        onDrop={(e) => {
          if (hasOsFiles(e)) dropProps.onDrop(e)
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={browser.isLoadingRoot}>
          {browser.error && !browser.isLoadingRoot ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center" role="alert">
              <p className="text-sm font-medium text-foreground">Couldn't load the files</p>
              <p className="break-all font-mono text-2xs text-muted-foreground">{browser.error}</p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="mt-1"
                onClick={browser.refresh}
              >
                Try again
              </Button>
            </div>
          ) : browser.isLoadingRoot ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner size={18} className="text-muted-foreground" label="Loading files" />
            </div>
          ) : browser.entries.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
              <p className="text-sm font-medium text-foreground">This folder is empty</p>
              {upload && (
                <>
                  <p className="text-pretty text-xs text-muted-foreground">
                    Drop files here or upload them from your computer.
                  </p>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="mt-2"
                    onClick={upload}
                  >
                    <Upload aria-hidden="true" />
                    Upload files
                  </Button>
                </>
              )}
            </div>
          ) : (
            <>
              {/* Column labels; each row carries the same widths. */}
              <div
                className={cn(
                  'sticky top-0 z-10 mx-1 flex h-6 items-center gap-1.5 bg-background pr-2 text-3xs font-medium text-muted-foreground',
                  SFTP_NAME_INSET_CLASS
                )}
                aria-hidden="true"
              >
                <span className="min-w-0 flex-1">Name</span>
                <span className={SFTP_SIZE_COL_CLASS}>Size</span>
                <span className={SFTP_MODIFIED_COL_CLASS}>Modified</span>
              </div>
              <ul className="pb-1">{browser.entries.map((entry) => renderEntry(entry))}</ul>
            </>
          )}
        </div>

        <SftpTransferTray connectionId={connectionId} />
        {focusedEntry && <SftpDetailsFooter entry={focusedEntry} />}
        {currentPath && (
          <SftpDropOverlay
            active={dragActive}
            path={dropRow ?? currentPath}
            intoRow={dropRow !== null}
          />
        )}
      </div>

      <Dialog open={nameDialog !== null} onOpenChange={(open) => !open && setNameDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">
              {nameDialog?.kind === 'rename'
                ? 'Rename'
                : nameDialog?.kind === 'folder'
                  ? 'New folder'
                  : 'New file'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {nameDialog?.kind === 'rename' ? (
                `Rename “${nameDialog.entry.name}”.`
              ) : (
                <>
                  In <span className="font-mono">{browser.currentPath ?? ''}</span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void submitName()
            }}
            className="space-y-1.5"
          >
            <Label htmlFor={nameId} className="text-xs">
              Name
            </Label>
            <Input
              id={nameId}
              value={nameValue}
              onChange={(e) => {
                setNameValue(e.target.value)
                setNameError(null)
              }}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? `${nameId}-error` : undefined}
              className="h-9 font-mono"
            />
            {nameError && (
              <p id={`${nameId}-error`} className="text-xs text-destructive">
                {nameError}
              </p>
            )}
            <DialogFooter className="gap-2 pt-3 sm:space-x-0">
              <Button type="button" variant="ghost" size="sm" onClick={() => setNameDialog(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {nameDialog?.kind === 'rename' ? 'Rename' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        isOpen={deleteEntry !== null}
        title={deleteEntry?.entryType === 'directory' ? 'Delete folder' : 'Delete file'}
        message={
          deleteEntry
            ? deleteEntry.entryType === 'directory'
              ? `Delete the folder “${deleteEntry.name}” on ${profileName}? It must be empty. This can't be undone.`
              : `Delete “${deleteEntry.name}” on ${profileName}? This can't be undone.`
            : ''
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteEntry(null)}
      />

      <ConfirmDialog
        isOpen={replace !== null}
        title={replaceCount === 1 ? 'Replace 1 file?' : `Replace ${replaceCount} files?`}
        message={
          replace
            ? `${nameList(replace.conflicts)} already ${replaceCount === 1 ? 'exists' : 'exist'} in ${replace.dir} on ${profileName}. Uploading replaces ${replaceCount === 1 ? 'it' : 'them'}. This can't be undone.`
            : ''
        }
        confirmLabel="Replace"
        variant="danger"
        onConfirm={transfers.confirmReplace}
        onCancel={transfers.cancelReplace}
      />
    </section>
  )
}
