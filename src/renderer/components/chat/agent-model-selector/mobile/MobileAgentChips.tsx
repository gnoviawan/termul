import { useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { TabGlyph } from '../SelectorRows'
import type { AgentTab } from '../selector-model'

export function AgentChips({
  tabs,
  viewId,
  badgeOf,
  disabled,
  onOpen
}: {
  tabs: readonly AgentTab[]
  viewId: string | null
  badgeOf: (tab: AgentTab) => string | null
  disabled: boolean
  onOpen: (tab: AgentTab) => void
}): React.JSX.Element | null {
  const rowRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const chips = rowRef.current?.querySelectorAll<HTMLElement>('[data-config-id]') ?? []
    const viewed = Array.from(chips).find((chip) => chip.dataset.configId === viewId)
    viewed?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [viewId])
  if (tabs.length < 2) return null
  return (
    <div
      ref={rowRef}
      role="tablist"
      aria-label="Agents"
      className="flex shrink-0 gap-2 overflow-x-auto px-3 pb-3 scrollbar-hide"
    >
      {tabs.map((tab) => {
        const selected = tab.configId === viewId
        const badge = badgeOf(tab)
        return (
          <button
            key={tab.configId}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={badge ? `${tab.name}, ${badge}` : tab.name}
            disabled={disabled}
            data-config-id={tab.configId}
            onClick={() => onOpen(tab)}
            className={cn(
              'flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-sm transition-colors duration-150 ease-out focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60',
              selected
                ? 'bg-foreground font-medium text-background'
                : 'bg-foreground/[0.05] text-secondary-foreground enabled:active:bg-foreground/10'
            )}
          >
            <TabGlyph tab={tab} colorClassName="text-current" />
            <span className="whitespace-nowrap">{tab.name}</span>
            {badge ? (
              <span
                className={cn(
                  'whitespace-nowrap text-xs',
                  selected ? 'text-background/70' : 'text-muted-foreground'
                )}
              >
                {badge}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
