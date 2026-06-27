import type { LucideIcon } from 'lucide-react'
import { Check } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export interface ComposerMenuItem {
  key: string
  label: string
  description?: string | null
  icon?: LucideIcon
  selected?: boolean
  dimmed?: boolean
  /** Wrap long labels/descriptions instead of truncating (used by skill rows). */
  wrap?: boolean
  /** Opaque payload round-tripped to `onSelect` (SlashItem, MentionMatch, …). */
  payload: unknown
}

export interface ComposerMenuSection {
  id: string
  heading: string
  items: ComposerMenuItem[]
}

export interface ComposerMenuHandle {
  /** Move highlight. */
  move: (delta: 1 | -1) => void
  /** Select the highlighted item. Returns true if an item was selected. */
  selectHighlighted: () => boolean
}

interface ComposerMenuProps {
  sections: ComposerMenuSection[]
  onSelect: (sectionId: string, item: ComposerMenuItem) => void
  emptyLabel?: string
}

interface FlatRow {
  sectionId: string
  item: ComposerMenuItem
}

/** Flatten sections to a single ordered list for highlight indexing. */
function flatten(sections: ComposerMenuSection[]): FlatRow[] {
  return sections.flatMap((s) => s.items.map((item) => ({ sectionId: s.id, item })))
}

/**
 * Shared inline picker shell rendered above the chat composer. Highlight
 * navigation is driven imperatively by the input (↑/↓/Enter) via the
 * forwarded handle, so the textarea keeps focus. Used by the slash-command
 * menu and the @-file mention menu. See ADR 0003.
 */
export const ComposerMenu = forwardRef<ComposerMenuHandle, ComposerMenuProps>(
  ({ sections, onSelect, emptyLabel }, ref) => {
    const flat = useMemo(() => flatten(sections), [sections])
    const [highlight, setHighlight] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      setHighlight((h) => (flat.length === 0 ? 0 : Math.min(h, flat.length - 1)))
    }, [flat.length])

    useEffect(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
      el?.scrollIntoView?.({ block: 'nearest' })
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
          const row = flat[Math.min(highlight, flat.length - 1)]
          if (!row) return false
          onSelect(row.sectionId, row.item)
          return true
        }
      }),
      [flat, highlight, onSelect]
    )

    if (flat.length === 0) {
      return (
        <div className="absolute bottom-full left-2 right-2 mb-1 rounded-md border border-border/60 bg-popover p-3 text-xs text-muted-foreground shadow-md">
          {emptyLabel ?? 'No items available.'}
        </div>
      )
    }

    let idx = -1
    return (
      <div
        ref={listRef}
        className="absolute bottom-full left-2 right-2 mb-1 max-h-64 overflow-y-auto rounded-md border border-border/60 bg-popover py-1 shadow-md"
      >
        {sections.map((section) => (
          <div key={section.id}>
            <div className="label-group px-3 py-1 text-muted-foreground/70">{section.heading}</div>
            {section.items.map((item) => {
              idx += 1
              const isHighlighted = idx === highlight
              const rowIdx = idx
              const Icon = item.icon
              return (
                <button
                  key={item.key}
                  type="button"
                  data-idx={rowIdx}
                  // Use mousedown so the textarea doesn't blur before we handle it.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onSelect(section.id, item)
                  }}
                  onMouseEnter={() => setHighlight(rowIdx)}
                  className={cn(
                    'flex w-full gap-2 px-3 py-1.5 text-left text-sm',
                    item.wrap ? 'flex-wrap items-start' : 'items-center',
                    isHighlighted ? 'bg-accent text-accent-foreground' : 'text-foreground',
                    item.dimmed && 'opacity-50'
                  )}
                >
                  {Icon && <Icon size={13} className="shrink-0 text-muted-foreground" />}
                  <span
                    className={cn('font-medium', item.wrap ? 'break-words' : 'min-w-0 truncate')}
                  >
                    {item.label}
                  </span>
                  {item.description && (
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-xs text-muted-foreground',
                        item.wrap && 'whitespace-normal break-words'
                      )}
                    >
                      {item.description}
                    </span>
                  )}
                  {item.selected && <Check size={13} className="ml-auto shrink-0 text-primary" />}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    )
  }
)

ComposerMenu.displayName = 'ComposerMenu'
