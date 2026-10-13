import type { SFTPEntry } from '@shared/types/ssh.types'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  File,
  FilePlus,
  Folder,
  FolderPlus,
  Link2,
  Pencil,
  RefreshCw,
  Trash2
} from '@/components/icons'
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
import { FOCUS_RING_CLASS, QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { joinPath, parentPath, useSftpBrowser } from '@/hooks/use-sftp-browser'
import { sshApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useSSHActions } from '@/stores/ssh-store'

interface SSHFileExplorerProps {
  /** Backend id of the connected session whose files are shown */
  connectionId: string
  profileName: string
}

type NameDialog = { kind: 'folder' } | { kind: 'file' } | { kind: 'rename'; entry: SFTPEntry }

const ICON_BUTTON = `${QUIET_ICON_BUTTON_CLASS} size-6`

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(1)} GB`
}

function validName(name: string): string | null {
  if (!name.trim()) return 'Enter a name.'
  if (name.includes('/')) return 'A name cannot contain “/”.'
  if (name === '.' || name === '..') return 'Choose a different name.'
  return null
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
  const nameId = useId()

  const openFile = async (entry: SFTPEntry) => {
    const result = await sshApi.sftpReadFile(connectionId, entry.path)
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

  const renderEntry = (entry: SFTPEntry, depth = 0): React.JSX.Element => {
    const isDir = entry.entryType === 'directory'
    const expanded = browser.expandedDirs.has(entry.path)
    const loading = browser.loadingDirs.has(entry.path)
    const children = browser.childEntries.get(entry.path) ?? []
    const Icon = isDir ? Folder : entry.entryType === 'symlink' ? Link2 : File
    return (
      <li key={entry.path}>
        <div className="group flex min-w-0 items-center pr-1 hover:bg-foreground/[0.03]">
          <button
            type="button"
            className={cn(
              'flex h-7 min-w-0 flex-1 items-center gap-1.5 text-left text-xs',
              FOCUS_RING_CLASS
            )}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            onClick={() =>
              isDir ? void browser.toggleDirectory(entry.path) : void openFile(entry)
            }
            aria-expanded={isDir ? expanded : undefined}
            title={isDir ? entry.path : `Open ${entry.name}`}
          >
            <span className="flex w-3.5 shrink-0 justify-center" aria-hidden="true">
              {isDir &&
                (loading ? (
                  <Spinner size={12} decorative className="text-muted-foreground" />
                ) : expanded ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                ))}
            </span>
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {!isDir && (
              <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
                {formatSize(entry.size)}
              </span>
            )}
          </button>
          <div className="flex shrink-0 items-center transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={() => showNameDialog({ kind: 'rename', entry })}
              aria-label={`Rename ${entry.name}`}
              title="Rename"
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className={cn(ICON_BUTTON, 'hover:text-destructive')}
              onClick={() => setDeleteEntry(entry)}
              aria-label={`Delete ${entry.name}`}
              title="Delete"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
        {isDir && expanded && children.length > 0 && (
          <ul>{children.map((child) => renderEntry(child, depth + 1))}</ul>
        )}
      </li>
    )
  }

  const atRoot = browser.currentPath === '/'

  return (
    <section className="flex h-full w-full flex-col" aria-label={`Files on ${profileName}`}>
      <div className="flex h-9 items-center justify-between gap-1 border-b border-border px-2">
        <span className="min-w-0 truncate pl-1 text-xs font-medium">Files</span>
        <div className="flex items-center">
          <button
            type="button"
            className={ICON_BUTTON}
            onClick={() =>
              browser.currentPath && void browser.loadDirectory(parentPath(browser.currentPath))
            }
            disabled={!browser.currentPath || atRoot}
            aria-label="Up one folder"
            title="Up one folder"
          >
            <ArrowUp size={12} />
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            onClick={() => showNameDialog({ kind: 'folder' })}
            disabled={!browser.currentPath}
            aria-label="New folder"
            title="New folder"
          >
            <FolderPlus size={12} />
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            onClick={() => showNameDialog({ kind: 'file' })}
            disabled={!browser.currentPath}
            aria-label="New file"
            title="New file"
          >
            <FilePlus size={12} />
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            onClick={browser.refresh}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {browser.currentPath && (
        <div className="border-b border-border px-3 py-1">
          <span
            className="block truncate font-mono text-3xs text-muted-foreground"
            title={browser.currentPath}
          >
            {browser.currentPath}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={browser.isLoadingRoot}>
        {browser.error && !browser.isLoadingRoot ? (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center" role="alert">
            <p className="text-xs text-foreground">Couldn't load the files</p>
            <p className="break-all text-3xs text-muted-foreground">{browser.error}</p>
            <Button type="button" size="xs" variant="outline" onClick={browser.refresh}>
              Try again
            </Button>
          </div>
        ) : browser.isLoadingRoot ? (
          <div className="flex h-20 items-center justify-center">
            <Spinner size={18} className="text-muted-foreground" label="Loading files" />
          </div>
        ) : browser.entries.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">This folder is empty.</p>
        ) : (
          <ul className="py-1">{browser.entries.map((entry) => renderEntry(entry))}</ul>
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
              {nameDialog?.kind === 'rename'
                ? `Rename “${nameDialog.entry.name}”.`
                : `In ${browser.currentPath ?? ''}`}
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
    </section>
  )
}
