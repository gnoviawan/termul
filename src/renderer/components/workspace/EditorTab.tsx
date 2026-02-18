import { useCallback, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getFileIcon } from '@/components/file-explorer/file-icon-map'
import { ContextMenu } from '@/components/ContextMenu'
import type { ContextMenuItem } from '@/components/ContextMenu'

function getBasename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

function getExtname(filePath: string): string {
  const name = getBasename(filePath)
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return ''
  return name.slice(dotIndex)
}

interface EditorTabProps {
  filePath: string
  isActive: boolean
  isDirty: boolean
  onSelect: () => void
  onClose: () => void
  onCloseOthers?: () => void
  onCloseAll?: () => void
  onCopyPath?: () => void
}

export function EditorTab({
  filePath,
  isActive,
  isDirty,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCopyPath
}: EditorTabProps): React.JSX.Element {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const fileName = getBasename(filePath)
  const ext = getExtname(filePath).slice(1) || null
  const Icon = getFileIcon(ext, false, false)

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const contextMenuItems: ContextMenuItem[] = [
    {
      label: 'Close',
      icon: <X size={14} />,
      onClick: onClose
    },
    {
      label: 'Close Others',
      onClick: onCloseOthers
    },
    {
      label: 'Close All',
      onClick: onCloseAll
    },
    {
      label: 'Copy Path',
      onClick: onCopyPath
    }
  ]

  return (
    <>
      <div
        onClick={onSelect}
        onContextMenu={handleContextMenu}
        className={cn(
          'h-full px-4 flex items-center border-r border-border min-w-[150px] cursor-pointer group transition-colors border-b-2 border-b-transparent',
          isActive
            ? 'bg-background border-b-primary'
            : 'hover:bg-secondary/50 text-muted-foreground'
        )}
      >
        {isDirty && (
          <span className="w-2 h-2 rounded-full bg-primary mr-1.5 flex-shrink-0" />
        )}
        <Icon size={14} className={cn('mr-2 flex-shrink-0', isActive ? 'text-primary' : '')} />
        <span
          className={cn(
            'text-sm font-medium truncate',
            isActive && 'text-foreground'
          )}
        >
          {fileName}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="ml-auto p-0.5 rounded-md hover:bg-secondary opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
        >
          <X size={12} />
        </button>
      </div>

      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}
