import { Check, Loader2, X } from 'lucide-react'
import { MaterialFileIcon } from '@/components/file-explorer/MaterialFileIcon'
import { cn } from '@/lib/utils'
import { TabContextMenu } from './tab-context-menu'

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
  operationStatus?: 'idle' | 'saving' | 'reloading' | 'saved'
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
  operationStatus = 'idle',
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCopyPath
}: EditorTabProps): React.JSX.Element {
  const fileName = getBasename(filePath)
  const ext = getExtname(filePath).slice(1) || null

  const isBusy = operationStatus === 'saving' || operationStatus === 'reloading'
  const showSuccess = operationStatus === 'saved'
  const showStatusIndicator = isBusy || showSuccess

  return (
    <TabContextMenu
      kind="editor"
      onClose={onClose}
      onCloseOthers={onCloseOthers}
      onCloseAll={onCloseAll}
      onCopyPath={onCopyPath}
    >
      <div
        onClick={onSelect}
        className={cn(
          'h-full px-3 flex items-center border-r border-border min-w-[100px] cursor-pointer group transition-colors border-b-2 border-b-transparent',
          isActive
            ? 'bg-background border-b-primary'
            : 'hover:bg-secondary/50 text-muted-foreground'
        )}
      >
        {isDirty && <span className="w-2 h-2 rounded-full bg-primary mr-1.5 flex-shrink-0" />}
        <MaterialFileIcon
          name={fileName}
          extension={ext}
          isDirectory={false}
          isExpanded={false}
          depth={0}
          size={12}
          className="mr-2"
        />
        <span className={cn('text-2xs font-medium truncate', isActive && 'text-foreground')}>
          {fileName}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (!showStatusIndicator) {
              onClose()
            }
          }}
          disabled={showStatusIndicator}
          title={
            operationStatus === 'saving'
              ? 'Saving file'
              : operationStatus === 'reloading'
                ? 'Reloading file'
                : operationStatus === 'saved'
                  ? `${fileName} saved`
                  : 'Close tab'
          }
          className={cn(
            'ml-auto p-0.5 rounded-md transition-opacity flex-shrink-0',
            showStatusIndicator
              ? 'opacity-100'
              : 'hover:bg-secondary opacity-0 group-hover:opacity-100',
            isBusy && 'disabled:cursor-wait',
            showSuccess && 'text-emerald-500'
          )}
        >
          {isBusy ? (
            <Loader2 size={12} className="animate-spin" />
          ) : showSuccess ? (
            <Check size={12} className="text-emerald-500" />
          ) : (
            <X size={12} />
          )}
        </button>
      </div>
    </TabContextMenu>
  )
}
