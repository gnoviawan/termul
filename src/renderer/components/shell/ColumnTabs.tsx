import { useRef } from 'react'
import { FolderTree, GitBranch, Github, type TermulIcon } from '@/components/icons'
import { CountBadge } from '@/components/ui/count-badge'
import { SEGMENTED_TRACK_CLASS, segmentClass } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import type { ShellLastColumnTab } from '@/stores/shell-layout-store'
import type { VisibleColumnTab } from './column-tab'

/**
 * Every tab is an equal-width icon; the label is its accessible name and tooltip.
 * Sidebar V2 P1 moved chats into the Rail, so the Chats tab is gone. TODO(P4):
 * chat search and chat import lived in the Chats tab (`ChatsList`) and are
 * unreachable until P4 brings them back to the Rail.
 */
const TABS: ReadonlyArray<{ id: VisibleColumnTab; label: string; Icon: TermulIcon }> = [
  { id: 'explorer', label: 'Explorer', Icon: FolderTree },
  { id: 'changes', label: 'Changes', Icon: GitBranch },
  { id: 'github', label: 'GitHub', Icon: Github }
]

export function columnTabId(tab: ShellLastColumnTab): string {
  return `side-panel-tab-${tab}`
}

export function columnPanelId(tab: ShellLastColumnTab): string {
  return `side-panel-panel-${tab}`
}

interface ColumnTabsProps {
  selected: VisibleColumnTab
  onSelect: (tab: VisibleColumnTab) => void
  /** Changed files of the working copy; the badge shows above 0 (capped at 99+). */
  changedCount: number
}

/**
 * Side panel Column tabs: Explorer, Changes, GitHub in a fixed order. A
 * `tablist` with a roving tabindex; Left/Right move and select, wrapping.
 */
export function ColumnTabs({
  selected,
  onSelect,
  changedCount
}: ColumnTabsProps): React.JSX.Element {
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.key === 'ArrowRight' ? 1 : -1
    const next = TABS[(index + step + TABS.length) % TABS.length]
    onSelect(next.id)
    tabRefs.current[next.id]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label="Side panel"
      className={cn(SEGMENTED_TRACK_CLASS, 'mx-2 mb-2 h-7')}
    >
      {TABS.map((tab, index) => {
        const active = tab.id === selected
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[tab.id] = el
            }}
            type="button"
            role="tab"
            id={columnTabId(tab.id)}
            aria-selected={active}
            aria-controls={columnPanelId(tab.id)}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            aria-label={tab.label}
            title={tab.label}
            className={cn(segmentClass(active), 'h-full min-w-0 flex-1 justify-center gap-1')}
          >
            <tab.Icon size={14} aria-hidden="true" />
            {tab.id === 'changes' && changedCount > 0 && (
              <CountBadge
                count={changedCount}
                max={99}
                data-testid="column-tab-changes-badge"
                className="h-3.5 min-w-3.5 text-4xs"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
