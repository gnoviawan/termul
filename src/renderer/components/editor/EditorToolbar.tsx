import { Code2, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'

interface EditorToolbarProps {
  viewMode: 'code' | 'markdown'
  onToggleViewMode: () => void
  filePath: string
}

export function EditorToolbar({
  viewMode,
  onToggleViewMode,
  filePath
}: EditorToolbarProps): React.JSX.Element {
  const fileName = filePath.split('/').pop() || filePath

  return (
    <div className="flex items-center justify-between px-3 h-8 border-b border-border bg-card flex-shrink-0">
      <span className="text-xs text-muted-foreground truncate">{fileName}</span>
      <button
        onClick={onToggleViewMode}
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors',
          'text-muted-foreground hover:text-foreground hover:bg-secondary'
        )}
        title={viewMode === 'markdown' ? 'Switch to source mode' : 'Switch to WYSIWYG mode'}
      >
        {viewMode === 'markdown' ? (
          <>
            <Code2 size={12} />
            <span>Source</span>
          </>
        ) : (
          <>
            <Eye size={12} />
            <span>Preview</span>
          </>
        )}
      </button>
    </div>
  )
}
