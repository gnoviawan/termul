import { Check, SlidersHorizontal, TerminalSquare } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { SlashItem, SlashSection } from './slash-menu-model'

export interface SlashMenuHandle {
  /** Move highlight. Returns true if handled. */
  move: (delta: 1 | -1) => void
  /** Select the highlighted item. Returns true if an item was selected. */
  selectHighlighted: () => boolean
}

interface SlashCommandMenuProps {
  sections: SlashSection[]
  onSelect: (item: SlashItem) => void
}

/** Flatten sections to a single ordered list for highlight indexing. */
function flatten(sections: SlashSection[]): SlashItem[] {
  return sections.flatMap((s) => s.items)
}

function itemKey(item: SlashItem): string {
  switch (item.kind) {
    case 'command':
      return `command:${item.name}`
    case 'config':
      return `config:${item.configId}:${item.valueId}`
    case 'mode':
      return `mode:${item.modeId}`
  }
}

/**
 * Inline slash-command menu rendered above the chat input. Highlight navigation
 * is driven imperatively by the input (↑/↓/Enter) via the forwarded handle, so
 * the textarea keeps focus.
 */
export const SlashCommandMenu = forwardRef<SlashMenuHandle, SlashCommandMenuProps>(
  ({ sections, onSelect }, ref) => {
    const flat = useMemo(() => flatten(sections), [sections])
    const [highlight, setHighlight] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)

    // Clamp the highlight whenever the item set changes (filtering, updates).
    useEffect(() => {
      setHighlight((h) => (flat.length === 0 ? 0 : Math.min(h, flat.length - 1)))
    }, [flat.length])

    // Keep the highlighted row visible so keyboard nav / Enter never targets an
    // off-screen item.
    useEffect(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    }, [highlight])

    useImperativeHandle(
      ref,
      () => ({
        move: (delta) => {
          if (flat.length === 0) return
          setHighlight((h) => (h + delta + flat.length) % flat.length)
        },
        selectHighlighted: () => {
          if (flat.length === 0) return false
          const item = flat[Math.min(highlight, flat.length - 1)]
          if (!item) return false
          onSelect(item)
          return true
        }
      }),
      [flat, highlight, onSelect]
    )

    if (sections.length === 0) {
      return (
        <div className="absolute bottom-full left-2 right-2 mb-1 rounded-md border border-border/60 bg-popover p-3 text-xs text-muted-foreground shadow-md">
          No commands available.
        </div>
      )
    }

    let flatIndex = -1
    return (
      <div
        ref={listRef}
        className="absolute bottom-full left-2 right-2 mb-1 max-h-64 overflow-y-auto rounded-md border border-border/60 bg-popover py-1 shadow-md"
      >
        {sections.map((section) => (
          <div key={section.id}>
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              {section.heading}
            </div>
            {section.items.map((item) => {
              flatIndex += 1
              const isHighlighted = flatIndex === highlight
              const idx = flatIndex
              const Icon = item.kind === 'command' ? TerminalSquare : SlidersHorizontal
              const selected = item.kind !== 'command' && item.selected
              const label = item.kind === 'command' ? `/${item.name}` : item.label
              const description = item.description
              return (
                <button
                  key={itemKey(item)}
                  type="button"
                  data-idx={idx}
                  // Use mousedown so the textarea doesn't blur before we handle it.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onSelect(item)
                  }}
                  onMouseEnter={() => setHighlight(idx)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                    isHighlighted ? 'bg-accent text-accent-foreground' : 'text-foreground'
                  )}
                >
                  <Icon size={13} className="shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{label}</span>
                  {description && (
                    <span className="truncate text-xs text-muted-foreground">{description}</span>
                  )}
                  {selected && <Check size={13} className="ml-auto shrink-0 text-primary" />}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    )
  }
)

SlashCommandMenu.displayName = 'SlashCommandMenu'
