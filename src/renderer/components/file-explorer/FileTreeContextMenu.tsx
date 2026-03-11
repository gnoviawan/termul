import {
  FilePlus,
  FolderPlus,
  Edit2,
  Trash2,
  Copy,
  Scissors,
  ClipboardPaste,
  Files,
  Terminal,
  ExternalLink,
  FolderOpen
} from 'lucide-react'
import { ContextMenu } from '@/components/ContextMenu'
import type { ContextMenuItem } from '@/components/ContextMenu'
import type { DirectoryEntry } from '@shared/types/filesystem.types'

interface FileTreeContextMenuProps {
  entry: DirectoryEntry
  x: number
  y: number
  onClose: () => void
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

export function FileTreeContextMenu({
  entry,
  x,
  y,
  onClose,
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
}: FileTreeContextMenuProps): React.JSX.Element {
  const items: ContextMenuItem[] = []
  const isDir = entry.type === 'directory'
  const selectionLabel = selectedCount > 1 ? ` (${selectedCount})` : ''

  // New File/Folder (directories only)
  if (isDir) {
    items.push(
      {
        label: 'New File',
        icon: <FilePlus size={14} />,
        onClick: () => onNewFile(entry.path)
      },
      {
        label: 'New Folder',
        icon: <FolderPlus size={14} />,
        onClick: () => onNewFolder(entry.path)
      },
      { type: 'separator' }
    )
  }

  // Clipboard operations
  items.push(
    {
      label: `Copy${selectionLabel}`,
      icon: <Copy size={14} />,
      onClick: () => onCopy()
    },
    {
      label: `Cut${selectionLabel}`,
      icon: <Scissors size={14} />,
      onClick: () => onCut()
    }
  )

  // Paste (only when clipboard has content and we're on a directory)
  if (hasClipboardContent && isDir) {
    items.push({
      label: 'Paste',
      icon: <ClipboardPaste size={14} />,
      onClick: () => onPaste(entry.path)
    })
  }

  items.push(
    {
      label: `Duplicate${selectionLabel}`,
      icon: <Files size={14} />,
      onClick: () => onDuplicate()
    },
    { type: 'separator' },
    {
      label: `Rename${selectedCount > 1 ? ' (1 item)' : ''}`,
      icon: <Edit2 size={14} />,
      onClick: () => onRename(entry),
      disabled: selectedCount > 1
    },
    {
      label: `Delete${selectionLabel}`,
      icon: <Trash2 size={14} />,
      onClick: () => onDelete(entry),
      variant: 'danger'
    },
    { type: 'separator' },
    {
      label: 'Copy Path',
      icon: <Copy size={14} />,
      onClick: () => onCopyPath(entry.path)
    }
  )

  // External operations
  items.push({ type: 'separator' })

  // Open in Terminal (directories only)
  if (isDir) {
    items.push({
      label: 'Open in Terminal',
      icon: <Terminal size={14} />,
      onClick: () => onOpenInTerminal(entry.path)
    })
  }

  // Open with External App (files only)
  if (!isDir) {
    items.push({
      label: 'Open with External App',
      icon: <ExternalLink size={14} />,
      onClick: () => onOpenWithExternal(entry.path)
    })
  }

  // Show in File Manager (always visible)
  items.push({
    label: 'Show in File Manager',
    icon: <FolderOpen size={14} />,
    onClick: () => onShowInFileManager(entry.path)
  })

  return <ContextMenu items={items} x={x} y={y} onClose={onClose} />
}