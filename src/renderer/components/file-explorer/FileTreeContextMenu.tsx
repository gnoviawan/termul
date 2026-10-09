import type { DirectoryEntry } from '@shared/types/filesystem.types'
import {
  ClipboardPaste,
  Copy,
  Edit2,
  ExternalLink,
  FilePlus,
  Files,
  FolderOpen,
  FolderPlus,
  Scissors,
  Terminal,
  Trash2
} from '@/components/icons'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import { isTauriContext } from '@/lib/tauri-runtime'

interface FileTreeContextMenuContentProps {
  entry: DirectoryEntry
  onNewFile: (dirPath: string) => void
  onNewFolder: (dirPath: string) => void
  onRename: (entry: DirectoryEntry) => void
  onDelete: (entry: DirectoryEntry) => void
  onCopyPath: (path: string) => void
  onCopy: () => void
  onCut: () => void
  onPaste: (destinationPath: string) => void
  onDuplicate: () => void
  onOpenInTerminal: (dirPath: string) => void
  onOpenWithExternal: (filePath: string) => void
  onShowInFileManager: (path: string) => void
  selectedCount?: number
  hasClipboardContent?: boolean
}

const ICON_CLASS = 'mr-2 h-3.5 w-3.5'

/**
 * Declarative Radix `<ContextMenuContent>` for a file-tree node.
 *
 * Rendered inside a `<ContextMenu><ContextMenuTrigger asChild>{node}</ContextMenuTrigger>`
 * wrapper in `FileExplorer`; the trigger opens the menu at the pointer and Radix
 * owns positioning/keyboard nav/Escape. Items use the canonical `onSelect` API.
 *
 * Groups: (folder) New File, New Folder | Copy, Cut, Paste, Duplicate |
 * Rename, Copy Path | Open in Terminal / Open with External App / Show in
 * File Manager | Delete (destructive, last). Desktop-only reveal/external-open
 * items are gated by `isTauriContext()` (absent on web, not just disabled) so
 * the FileExplorer parity invariants stay green.
 */
export function FileTreeContextMenuContent({
  entry,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onCopyPath,
  onCopy,
  onCut,
  onPaste,
  onDuplicate,
  onOpenInTerminal,
  onOpenWithExternal,
  onShowInFileManager,
  selectedCount = 1,
  hasClipboardContent = false
}: FileTreeContextMenuContentProps): React.JSX.Element {
  const isDir = entry.type === 'directory'
  const selectionLabel = selectedCount > 1 ? ` (${selectedCount})` : ''
  const isDesktop = isTauriContext()

  return (
    <ContextMenuContent className="w-56">
      {/* New File/Folder (directories only) */}
      {isDir && (
        <>
          <ContextMenuItem onSelect={() => onNewFile(entry.path)}>
            <FilePlus className={ICON_CLASS} /> New File
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onNewFolder(entry.path)}>
            <FolderPlus className={ICON_CLASS} /> New Folder
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}

      {/* Clipboard operations */}
      <ContextMenuItem onSelect={onCopy}>
        <Copy className={ICON_CLASS} /> Copy{selectionLabel}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCut}>
        <Scissors className={ICON_CLASS} /> Cut{selectionLabel}
      </ContextMenuItem>

      {/* Paste (only when clipboard has content and we're on a directory) */}
      {hasClipboardContent && isDir && (
        <ContextMenuItem onSelect={() => onPaste(entry.path)}>
          <ClipboardPaste className={ICON_CLASS} /> Paste
        </ContextMenuItem>
      )}

      <ContextMenuItem onSelect={onDuplicate}>
        <Files className={ICON_CLASS} /> Duplicate{selectionLabel}
      </ContextMenuItem>
      <ContextMenuSeparator />

      <ContextMenuItem onSelect={() => onRename(entry)} disabled={selectedCount > 1}>
        <Edit2 className={ICON_CLASS} /> Rename{selectedCount > 1 ? ' (1 item)' : ''}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onCopyPath(entry.path)}>
        <Copy className={ICON_CLASS} /> Copy Path
      </ContextMenuItem>

      {/* External operations — separator only when at least one following
          item is visible (Open in Terminal on any platform, or the
          desktop-only reveal/open-external items). */}
      {(isDir || isDesktop) && <ContextMenuSeparator />}

      {/* Open in Terminal (directories only — works on web too, server PTY) */}
      {isDir && (
        <ContextMenuItem onSelect={() => onOpenInTerminal(entry.path)}>
          <Terminal className={ICON_CLASS} /> Open in Terminal
        </ContextMenuItem>
      )}

      {/* Open with External App (files only, desktop-only — no browser equivalent) */}
      {isDesktop && !isDir && (
        <ContextMenuItem onSelect={() => onOpenWithExternal(entry.path)}>
          <ExternalLink className={ICON_CLASS} /> Open with External App
        </ContextMenuItem>
      )}

      {/* Show in File Manager (desktop-only — no browser equivalent) */}
      {isDesktop && (
        <ContextMenuItem onSelect={() => onShowInFileManager(entry.path)}>
          <FolderOpen className={ICON_CLASS} /> Show in File Manager
        </ContextMenuItem>
      )}

      {/* Delete is destructive: last, in its own group. */}
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onSelect={() => onDelete(entry)}>
        <Trash2 className={ICON_CLASS} /> Delete{selectionLabel}…
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
