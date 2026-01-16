/**
 * WorktreeContextMenu Component
 *
 * Context menu for worktree actions: Open Terminal, Archive, Delete, Show in Explorer.
 * Source: Story 1.5 - Task 7: Add Worktree Actions Menu
 */

import { memo } from 'react'
import { Terminal, Archive, Trash2, FolderOpen, ExternalLink } from 'lucide-react'
import { ContextMenu } from '@/components/ContextMenu'
import type { ContextMenuItem } from '@/components/ContextMenu'
import type { WorktreeMetadata } from '../../worktree.types'

export interface WorktreeContextMenuProps {
  worktree: WorktreeMetadata
  isOpen: boolean
  x: number
  y: number
  onClose: () => void
  onOpenTerminal?: (worktreeId: string) => void
  onArchive?: (worktreeId: string) => void
  onDelete?: (worktreeId: string) => void
  onShowInExplorer?: (worktreeId: string) => void
}

/**
 * Get platform-specific label for "Show in File Explorer"
 */
function getShowInExplorerLabel(): string {
  return window.api.platform === 'darwin'
    ? 'Show in Finder'
    : 'Show in File Explorer'
}

/**
 * WorktreeContextMenu - Context menu for worktree actions
 */
export const WorktreeContextMenu = memo(({
  worktree,
  isOpen,
  x,
  y,
  onClose,
  onOpenTerminal,
  onArchive,
  onDelete,
  onShowInExplorer
}: WorktreeContextMenuProps) => {
  console.log('[WorktreeContextMenu] Rendered with isOpen:', isOpen, 'worktree:', worktree.branchName, 'position:', { x, y })

  const items: ContextMenuItem[] = [
    {
      label: 'Open Terminal',
      icon: <Terminal size={14} />,
      onClick: () => {
        onOpenTerminal?.(worktree.id)
        onClose()
      },
      shortcut: 'Ctrl+T'
    },
    {
      label: getShowInExplorerLabel(),
      icon: <FolderOpen size={14} />,
      onClick: () => {
        onShowInExplorer?.(worktree.id)
        onClose()
      }
    },
    {
      label: 'Open in Editor',
      icon: <ExternalLink size={14} />,
      onClick: () => {
        // This would be implemented later to open in configured editor
        onClose()
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Archive',
      icon: <Archive size={14} />,
      onClick: () => {
        onArchive?.(worktree.id)
        onClose()
      }
    },
    {
      label: 'Delete',
      icon: <Trash2 size={14} />,
      onClick: () => {
        onDelete?.(worktree.id)
        onClose()
      },
      variant: 'danger'
    }
  ]

  return (
    <ContextMenu
      items={items}
      x={x}
      y={y}
      onClose={onClose}
    />
  )
})

WorktreeContextMenu.displayName = 'WorktreeContextMenu'
