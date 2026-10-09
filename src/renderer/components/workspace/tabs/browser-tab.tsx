import { Globe } from '@/components/icons'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { TabContextMenu } from '../tab-context-menu'
import { TabChrome } from './tab-chrome'
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
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  bulkMenu
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
      <TabChrome
        isActive={isActive}
        isDragging={isDragging}
        isDropTarget={isDropTarget}
        dropPosition={dropPosition}
        onSelect={onSelect}
        onClose={onClose}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        icon={<Globe size={12} />}
        label={label}
        after={
          browserTab?.agentControlled ? (
            <span
              title="This tab is being driven by the agent — closing it revokes control"
              className="flex h-4 shrink-0 items-center rounded bg-primary/15 px-1 text-4xs font-semibold uppercase leading-none tracking-wide text-primary"
            >
              Agent
            </span>
          ) : undefined
        }
        pinClose={isActive}
      />
    </TabContextMenu>
  )
}
