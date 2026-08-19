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
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
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

/**
 * Declarative Radix `<ContextMenuContent>` for a file-tree node.
 *
 * Rendered inside a `<ContextMenu><ContextMenuTrigger asChild>{node}</ContextMenuTrigger>`
 * wrapper in `FileExplorer`; the trigger opens the menu at the pointer and Radix
 * owns positioning/keyboard nav/Escape. Items use the canonical `onSelect` API
 * and the `mr-2 h-4 w-4` icon convention. Desktop-only reveal/external-open
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
  const { t } = useTranslation('projects')
  const isDir = entry.type === 'directory'
  const selectionLabel =
    selectedCount > 1 ? t('fileContext.selectedSuffix', { count: selectedCount }) : ''

  return (
    <ContextMenuContent className="w-56">
      {/* New File/Folder (directories only) */}
      {isDir && (
        <>
          <ContextMenuItem onSelect={() => onNewFile(entry.path)}>
            <FilePlus className="mr-2 h-4 w-4" /> {t('fileContext.newFile')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onNewFolder(entry.path)}>
            <FolderPlus className="mr-2 h-4 w-4" /> {t('fileContext.newFolder')}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}

      {/* Clipboard operations */}
      <ContextMenuItem onSelect={onCopy}>
        <Copy className="mr-2 h-4 w-4" /> {t('fileContext.copy')}
        {selectionLabel}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCut}>
        <Scissors className="mr-2 h-4 w-4" /> {t('fileContext.cut')}
        {selectionLabel}
      </ContextMenuItem>

      {/* Paste (only when clipboard has content and we're on a directory) */}
      {hasClipboardContent && isDir && (
        <ContextMenuItem onSelect={() => onPaste(entry.path)}>
          <ClipboardPaste className="mr-2 h-4 w-4" /> {t('fileContext.paste')}
        </ContextMenuItem>
      )}

      <ContextMenuItem onSelect={onDuplicate}>
        <Files className="mr-2 h-4 w-4" /> {t('fileContext.duplicate')}
        {selectionLabel}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onRename(entry)} disabled={selectedCount > 1}>
        <Edit2 className="mr-2 h-4 w-4" />
        {selectedCount > 1 ? t('fileContext.renameSingleItem') : t('fileContext.rename')}
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={() => onDelete(entry)}>
        <Trash2 className="mr-2 h-4 w-4" /> {t('fileContext.delete')}
        {selectionLabel}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onCopyPath(entry.path)}>
        <Copy className="mr-2 h-4 w-4" /> {t('fileContext.copyPath')}
      </ContextMenuItem>

      {/* External operations — separator only when at least one following
          item is visible (Open in Terminal on any platform, or the
          desktop-only reveal/open-external items). */}
      {(isDir || isTauriContext()) && <ContextMenuSeparator />}

      {/* Open in Terminal (directories only — works on web too, server PTY) */}
      {isDir && (
        <ContextMenuItem onSelect={() => onOpenInTerminal(entry.path)}>
          <Terminal className="mr-2 h-4 w-4" /> {t('fileContext.openInTerminal')}
        </ContextMenuItem>
      )}

      {/* Open with External App (files only, desktop-only — no browser equivalent) */}
      {isTauriContext() && !isDir && (
        <ContextMenuItem onSelect={() => onOpenWithExternal(entry.path)}>
          <ExternalLink className="mr-2 h-4 w-4" /> {t('fileContext.openWithExternal')}
        </ContextMenuItem>
      )}

      {/* Show in File Manager (desktop-only — no browser equivalent) */}
      {isTauriContext() && (
        <ContextMenuItem onSelect={() => onShowInFileManager(entry.path)}>
          <FolderOpen className="mr-2 h-4 w-4" /> {t('fileContext.showInFileManager')}
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  )
}
