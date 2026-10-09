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
import { Check, type TermulIcon } from '@/components/icons'
import {
  MENU_ACTIVE_ROW_CLASS,
  MENU_LABEL_CLASS,
  MENU_OPTION_ROW_CLASS
} from '@/components/ui/menu-styles'
import { cn } from '@/lib/utils'
import { useTapSelect } from './use-tap-select'

export interface ComposerMenuItem {
  key: string
  label: string
  description?: string | null
  icon?: TermulIcon
  /** Override the default muted icon color (e.g. skill rows use `text-primary`
   * to match the accent `SkillChip`). Resolved via `cn`, so later classes win. */
  iconClassName?: string
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
  inputRef?: RefObject<HTMLElement | null>
}

interface FlatRow {
  sectionId: string
  item: ComposerMenuItem
}

/** Popover shell above the composer: 12px radius, 4px padding (rows are 8px). */
const COMPOSER_MENU_SHELL_CLASS =
  'absolute bottom-full left-2 right-2 mb-1 rounded-xl border bg-popover p-1 text-popover-foreground shadow-md'

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
    // Story 5.3 (T4.2): a tap selects exactly once; a drag-scroll does not.
    const tapSelect = useTapSelect()
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
        <div id={listboxId} className={COMPOSER_MENU_SHELL_CLASS}>
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {emptyLabel ?? 'Nothing matches. Try another name.'}
          </div>
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
        className={cn(COMPOSER_MENU_SHELL_CLASS, 'max-h-[40vh] overflow-y-auto @[400px]:max-h-64')}
      >
        {sections.map((section) => (
          <div key={section.id}>
            <div className={MENU_LABEL_CLASS}>{section.heading}</div>
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
                  // Story 5.3 (T4.2): iOS may fire `mousedown` after
                  // `touchend`, or both for one tap; `tapSelect` selects on
                  // `touchend` and drops the synthesized click.
                  // `onMouseDown` keeps `preventDefault` so the editor does
                  // not blur on the mouse path; select happens on click so a
                  // drag can cancel.
                  {...tapSelect(() => onSelect(section.id, item))}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlight(rowIdx)}
                  className={cn(
                    // Story 5.3 (T4.1): raise the touch hit-target height on
                    // narrow panes (mobile) to ≥44px. The `@[400px]:` variant
                    // restores `py-1.5` on wider panes (desktop
                    // non-regression); `pointer-coarse:@[400px]:` keeps the
                    // 44px row for a touch pointer in a wide pane (a landscape
                    // phone). Pure CSS variant — no JS two-branch
                    // render (Story 5.1 threshold-remount lesson).
                    // Rows are rounded-lg (8px), concentric with the
                    // rounded-xl (12px) shell and its 4px padding.
                    MENU_OPTION_ROW_CLASS,
                    'min-h-11 py-2.5 @[400px]:min-h-8 @[400px]:py-1.5 pointer-coarse:@[400px]:min-h-11 pointer-coarse:@[400px]:py-2.5',
                    item.wrap ? 'flex-wrap items-start' : 'items-center',
                    isHighlighted && MENU_ACTIVE_ROW_CLASS,
                    item.dimmed && 'text-disabled-foreground'
                  )}
                >
                  {Icon && (
                    <Icon
                      size={14}
                      className={cn('shrink-0 text-muted-foreground', item.iconClassName)}
                    />
                  )}
                  <span
                    className={cn('font-medium', item.wrap ? 'break-words' : 'min-w-0 truncate')}
                  >
                    {item.label}
                  </span>
                  {item.description && (
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-2xs text-muted-foreground',
                        item.wrap && 'whitespace-normal break-words'
                      )}
                    >
                      {item.description}
                    </span>
                  )}
                  {item.selected && (
                    <Check size={14} className="ml-auto shrink-0 text-foreground" />
                  )}
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
