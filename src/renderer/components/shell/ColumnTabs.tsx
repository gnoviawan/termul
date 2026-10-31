import { useRef } from 'react'
import { Github, type TermulIcon } from '@/components/icons'
import { CountBadge } from '@/components/ui/count-badge'
import { SEGMENTED_TRACK_CLASS, segmentClass } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import type { ShellLastColumnTab } from '@/stores/shell-layout-store'

/**
 * `Icon` makes a tab icon-only (its label is the accessible name and tooltip):
 * four text segments do not fit the 220px minimum panel width.
 */
const TABS: ReadonlyArray<{ id: ShellLastColumnTab; label: string; Icon?: TermulIcon }> = [
  { id: 'chats', label: 'Chats' },
  { id: 'explorer', label: 'Explorer' },
  { id: 'changes', label: 'Changes' },
  { id: 'github', label: 'GitHub', Icon: Github }
]

export function columnTabId(tab: ShellLastColumnTab): string {
  return `side-panel-tab-${tab}`
}

export function columnPanelId(tab: ShellLastColumnTab): string {
  return `side-panel-panel-${tab}`
}

interface ColumnTabsProps {
  selected: ShellLastColumnTab
  onSelect: (tab: ShellLastColumnTab) => void
  /** Changed files of the working copy; the badge shows above 0 (capped at 99+). */
  changedCount: number
}

/**
 * Side panel Column tabs: Chats, Explorer, Changes, GitHub in a fixed order. A
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
            aria-label={tab.Icon ? tab.label : undefined}
            title={tab.Icon ? tab.label : undefined}
            className={cn(
              segmentClass(active),
              'h-full justify-center gap-1.5',
              tab.Icon ? 'shrink-0' : 'min-w-0 flex-auto'
            )}
          >
            {tab.Icon ? (
              <tab.Icon size={14} aria-hidden="true" />
            ) : (
              <span className="min-w-0 truncate">{tab.label}</span>
            )}
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
