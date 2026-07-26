import type { LucideIcon } from 'lucide-react'
import { Check } from 'lucide-react'
import {
  forwardRef,
  type RefObject,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
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
  /**
   * The composer textarea that owns this listbox. When provided, the menu wires
   * `aria-controls`/`aria-activedescendant` on it so assistive tech can track
   * the highlighted option while keyboard focus stays in the textarea.
   */
  inputRef?: RefObject<HTMLTextAreaElement | null>
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
  ({ sections, onSelect, emptyLabel, inputRef }, ref) => {
    const flat = useMemo(() => flatten(sections), [sections])
    const [highlight, setHighlight] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)
    // Story 5.3 (T4.2): guard against touch→mouse synthesis double-fire.
    // Tracks the last input type so a tap selects exactly once. Reset after
    // 500ms so the next interaction starts fresh.
    const lastInputType = useRef<'mouse' | 'touch' | null>(null)
    // Stable id for the listbox + each option so the owning textarea can
    // reference the active option via `aria-activedescendant`.
    const listboxId = useId()
    const clampedHighlight = flat.length === 0 ? 0 : Math.min(highlight, flat.length - 1)
    const activeOptionId = flat.length > 0 ? `${listboxId}-opt-${clampedHighlight}` : null

    useEffect(() => {
      setHighlight((h) => (flat.length === 0 ? 0 : Math.min(h, flat.length - 1)))
    }, [flat.length])

    useEffect(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
      el?.scrollIntoView?.({ block: 'nearest' })
    }, [highlight])

    // Expose the listbox to the owning textarea: `aria-controls` points at the
    // listbox and `aria-activedescendant` tracks the highlighted option. Cleared
    // on unmount (menu closed) or when there are no options.
    useEffect(() => {
      const input = inputRef?.current
      if (!input) return
      if (activeOptionId) {
        input.setAttribute('aria-controls', listboxId)
        input.setAttribute('aria-activedescendant', activeOptionId)
      } else {
        input.removeAttribute('aria-controls')
        input.removeAttribute('aria-activedescendant')
      }
      return () => {
        input.removeAttribute('aria-controls')
        input.removeAttribute('aria-activedescendant')
      }
    }, [activeOptionId, listboxId, inputRef])

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
        <div
          id={listboxId}
          className="absolute bottom-full left-2 right-2 mb-1 rounded-md border border-border/60 bg-popover p-3 text-xs text-muted-foreground shadow-md"
        >
          {emptyLabel ?? 'No items available.'}
        </div>
      )
    }

    let idx = -1
    return (
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        // Story 5.3 (T4.3): cap the menu height on short mobile viewports with
        // OSK. The default `max-h-64` (16rem) is fine on desktop; on a narrow
        // pane (mobile), use `max-h-[40vh]` so a long slash list doesn't push
        // above the top of the visible viewport. The `@[400px]:` variant
        // restores `max-h-64` on wider panes (desktop non-regression).
        className="absolute bottom-full left-2 right-2 mb-1 max-h-[40vh] @[400px]:max-h-64 overflow-y-auto rounded-md border border-border/60 bg-popover py-1 shadow-md"
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
                  id={`${listboxId}-opt-${rowIdx}`}
                  type="button"
                  role="option"
                  aria-selected={isHighlighted}
                  tabIndex={-1}
                  data-idx={rowIdx}
                  // Story 5.3 (T4.2): touch synthesis on iOS can fire
                  // `mousedown` after `touchend` unreliably, or fire both for
                  // a single tap. We add `onTouchEnd` to select reliably on
                  // touch, and guard with a "last input type" ref so a tap
                  // selects exactly once. `onMouseDown` keeps `preventDefault`
                  // so the textarea doesn't blur on mouse path.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    if (lastInputType.current === 'touch') {
                      // The touch path already fired `onSelect`; bail to
                      // avoid double-select on synthesis double-fire.
                      return
                    }
                    onSelect(section.id, item)
                  }}
                  onTouchEnd={(e) => {
                    e.preventDefault()
                    lastInputType.current = 'touch'
                    onSelect(section.id, item)
                    // Reset the guard after a short delay so the next
                    // interaction (mouse or touch) starts fresh.
                    window.setTimeout(() => {
                      if (lastInputType.current === 'touch') {
                        lastInputType.current = null
                      }
                    }, 500)
                  }}
                  onMouseEnter={() => setHighlight(rowIdx)}
                  className={cn(
                    // Story 5.3 (T4.1): raise the touch hit-target height on
                    // narrow panes (mobile) to ≥44px. The `@[400px]:` variant
                    // restores `py-1.5` on wider panes (desktop
                    // non-regression). Pure CSS variant — no JS two-branch
                    // render (Story 5.1 threshold-remount lesson).
                    'flex w-full gap-2 px-3 py-2.5 @[400px]:py-1.5 text-left text-sm',
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
