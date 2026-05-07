import { Code2, Eye, List, GitCompare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useTocIsVisible, useTocSettingsStore } from '@/stores/toc-settings-store'

interface EditorToolbarProps {
  viewMode: 'code' | 'markdown'
  onToggleViewMode: () => void
  filePath: string
  hasGitChanges?: boolean
  showDiff?: boolean
  onToggleDiff?: () => void
}

export function EditorToolbar({
  viewMode,
  onToggleViewMode,
  filePath,
  hasGitChanges = false,
  showDiff = false,
  onToggleDiff,
}: EditorToolbarProps): React.JSX.Element {
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  const isTocVisible = useTocIsVisible()
  const toggleTocVisibility = useTocSettingsStore((state) => state.toggleVisibility)

  return (
    <div className="flex items-center justify-between px-3 h-8 border-b border-border bg-card flex-shrink-0">
      <span className="text-xs text-muted-foreground truncate">{fileName}</span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground',
            isTocVisible && 'bg-accent text-accent-foreground'
          )}
          onClick={toggleTocVisibility}
          title="Toggle Table of Contents"
          aria-pressed={isTocVisible}
        >
          <List size={12} />
          <span>TOC</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleViewMode}
          className={cn(
            'h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary',
            showDiff && 'pointer-events-none opacity-40',
          )}
          title={showDiff ? 'Disabled in diff mode' : viewMode === 'markdown' ? 'Switch to source mode' : 'Switch to WYSIWYG mode'}
          disabled={showDiff}
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
        </Button>

        {hasGitChanges && onToggleDiff && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleDiff}
            className={cn(
              'h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground',
              showDiff && 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
            )}
            title={showDiff ? 'Close diff view' : 'Show git diff'}
            aria-pressed={showDiff}
          >
            <GitCompare size={12} />
            <span>Diff</span>
          </Button>
        )}
      </div>
    </div>
  )
}
