import { Code2, Eye, List, Save } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { requestSaveEditorFile } from '@/lib/editor-save'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/stores/editor-store'
import { useTocIsVisible, useTocSettingsStore } from '@/stores/toc-settings-store'

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
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  const isTocVisible = useTocIsVisible()
  const toggleTocVisibility = useTocSettingsStore((state) => state.toggleVisibility)
  // Story 9: on the mobile web shell the desktop h-6 (24px) tabs are far
  // under the 44px touch floor. Swap them to the `touch` button size
  // (h-11 + hit-slop overlay) and keep the toolbar row at h-8; desktop
  // density is byte-identical.
  const isMobileWebShell = useMobileWebShell()
  // Story 4: the mobile editor has no other save path (no Ctrl key, hidden
  // desktop tab strip), so the toolbar exposes an explicit Save affordance.
  // Disabled unless the buffer is dirty; while a save is in flight it stays
  // disabled (requestSaveEditorFile runs the same store saveFile as Ctrl+S,
  // including flush → write → dirty-clear → boundary log).
  const fileState = useEditorStore((state) => state.openFiles.get(filePath))
  const isDirty = Boolean(fileState?.isDirty)
  const isSaving = fileState?.operationStatus === 'saving'
  const [saveTapped, setSaveTapped] = useState(false)

  const handleSave = useCallback(() => {
    const file = useEditorStore.getState().openFiles.get(filePath)
    if (!file || !file.isDirty) return
    setSaveTapped(true)
    void requestSaveEditorFile(filePath).finally(() => setSaveTapped(false))
  }, [filePath])

  return (
    <div
      className={cn(
        'flex items-center justify-between border-b border-border bg-card flex-shrink-0',
        isMobileWebShell ? 'h-8 px-2' : 'px-3 h-8'
      )}
    >
      <span className="text-xs text-muted-foreground truncate">{fileName}</span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size={isMobileWebShell ? 'touch' : 'sm'}
          className={cn(
            'gap-1 px-2 text-xs text-muted-foreground hover:text-foreground',
            isMobileWebShell && 'min-h-11',
            !isMobileWebShell && 'h-6',
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
          size={isMobileWebShell ? 'touch' : 'sm'}
          onClick={onToggleViewMode}
          className={cn(
            'gap-1 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary',
            isMobileWebShell && 'min-h-11',
            !isMobileWebShell && 'h-6'
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
        </Button>

        {isMobileWebShell && (
          <Button
            variant="ghost"
            size="touch"
            className={cn(
              'gap-1 min-h-11 px-3 text-xs',
              isDirty ? 'text-foreground' : 'text-muted-foreground'
            )}
            onClick={handleSave}
            disabled={!isDirty || isSaving || saveTapped}
            title={isDirty ? 'Save file' : 'No unsaved changes'}
            aria-label={`Save ${fileName}`}
          >
            <Save size={12} />
            <span>Save</span>
          </Button>
        )}
      </div>
    </div>
  )
}
