import { FilePlus, FolderPlus, Edit2, Trash2, Copy } from 'lucide-react'
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
  onCopyPath
}: FileTreeContextMenuProps): React.JSX.Element {
  const items: ContextMenuItem[] = []

  if (entry.type === 'directory') {
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
      }
    )
  }

  items.push(
    {
      label: 'Rename',
      icon: <Edit2 size={14} />,
      onClick: () => onRename(entry)
    },
    {
      label: 'Delete',
      icon: <Trash2 size={14} />,
      onClick: () => onDelete(entry),
      variant: 'danger'
    },
    {
      label: 'Copy Path',
      icon: <Copy size={14} />,
      onClick: () => onCopyPath(entry.path)
    }
  )

  return <ContextMenu items={items} x={x} y={y} onClose={onClose} />
}
