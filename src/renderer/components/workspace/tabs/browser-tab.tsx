import { Globe, X as XIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { TAB_CLOSE_BUTTON_CLASS, TabCloseReveal } from '../EditorTab'
import { handleTabAuxClick, TabContextMenu } from '../tab-context-menu'
import type { TabInlineProps } from './types'

interface BrowserTabInlineProps extends TabInlineProps {
  tab: { type: 'browser'; id: string; browserTabId: string }
}

export function BrowserTabInline({
  tab,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  bulkMenu,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: BrowserTabInlineProps): React.JSX.Element {
  const browserTab = useBrowserSessionStore((state) => state.getTab(tab.browserTabId))
  const label = (() => {
    if (!browserTab) return 'Browser'
    if (browserTab.title.trim()) return browserTab.title.trim()
    if (browserTab.url) {
      try {
        const parsed = new URL(browserTab.url)
        return parsed.host || parsed.hostname || browserTab.url
      } catch {
        return browserTab.url.replace(/^https?:\/\//, '').split('/')[0] || 'Browser'
      }
    }
    return 'Browser'
  })()

  return (
    <TabContextMenu kind="browser" onClose={onClose} {...bulkMenu}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onSelect}
        onAuxClick={(e) => handleTabAuxClick(e, onClose)}
        className={cn(
          'relative h-full px-3 flex items-center border-r border-border min-w-[100px] cursor-pointer group transition-[opacity,transform,background-color] duration-150 ease-out',
          isActive ? 'bg-background' : 'hover:bg-secondary/50 text-muted-foreground',
          isDragging && 'opacity-50 scale-[0.98]'
        )}
      >
        {/* Drop indicator line */}
        {isDropTarget && dropPosition === 'before' && (
          <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary-fill rounded-full" />
        )}
        {isDropTarget && dropPosition === 'after' && (
          <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary-fill rounded-full" />
        )}

        <div className="flex min-w-0 items-center">
          <Globe size={12} className={cn('shrink-0', isActive ? 'text-primary' : '')} />
          <span
            className={cn(
              'ml-2 min-w-0 truncate text-2xs font-medium',
              isActive && 'text-foreground'
            )}
          >
            {label}
          </span>
          {browserTab?.agentControlled && (
            <span
              title="This tab is being driven by the agent — closing it revokes control"
              className="ml-1.5 shrink-0 rounded bg-primary-fill/15 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary"
            >
              Agent
            </span>
          )}
        </div>
        <TabCloseReveal pinned={isActive}>
          <button
            type="button"
            tabIndex={isActive ? undefined : -1}
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className={TAB_CLOSE_BUTTON_CLASS}
          >
            <XIcon size={11} />
          </button>
        </TabCloseReveal>
      </div>
    </TabContextMenu>
  )
}
