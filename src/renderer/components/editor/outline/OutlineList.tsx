import { LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from '@/components/icons'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import type { TocHeading } from '@/hooks/use-toc-headings'
import { cn } from '@/lib/utils'
import type { OutlineRow } from './outline-rows'

/** Row inset: 6px base plus 12px per level below the shallowest heading. */
export function getRowPaddingLeft(depth: number): number {
  return 6 + depth * 12
}

/** Top-level rows read as medium secondary text; deeper rows are muted. */
export function getDepthToneClass(depth: number): string {
  return depth === 0 ? 'font-medium text-secondary-foreground' : 'text-muted-foreground'
}

const RAIL_TRANSITION = { duration: 0.18, ease: 'easeOut' } as const
const NO_TRANSITION = { duration: 0 } as const

interface OutlineListProps {
  rows: OutlineRow[]
  /** Id of the visible row that stands for the active heading. */
  activeRowId?: string
  onHeadingClick: (heading: TocHeading) => void
  onToggleCollapsed: (key: string) => void
}

export function OutlineList({
  rows,
  activeRowId,
  onHeadingClick,
  onToggleCollapsed
}: OutlineListProps): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  const layoutGroupId = useId()
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const activeIndex = rows.findIndex((row) => row.heading.id === activeRowId)
  const [focusIndex, setFocusIndex] = useState(Math.max(0, activeIndex))
  const hasFocusRef = useRef(false)

  // Keep the roving tab stop on the active row while focus is outside the list.
  useEffect(() => {
    if (!hasFocusRef.current && activeIndex >= 0) {
      setFocusIndex(activeIndex)
    }
  }, [activeIndex])

  const safeFocusIndex = Math.min(focusIndex, Math.max(0, rows.length - 1))

  const focusRow = (index: number): void => {
    const row = rows[index]
    if (!row) return
    setFocusIndex(index)
    rowRefs.current.get(row.heading.id)?.focus()
  }

  const handleKeyDown = (event: React.KeyboardEvent, index: number, row: OutlineRow): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusRow(Math.min(rows.length - 1, index + 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        focusRow(Math.max(0, index - 1))
        break
      case 'Home':
        event.preventDefault()
        focusRow(0)
        break
      case 'End':
        event.preventDefault()
        focusRow(rows.length - 1)
        break
      case 'ArrowLeft':
        if (row.hasChildren && !row.isCollapsed) {
          event.preventDefault()
          onToggleCollapsed(row.key)
        }
        break
      case 'ArrowRight':
        if (row.hasChildren && row.isCollapsed) {
          event.preventDefault()
          onToggleCollapsed(row.key)
        }
        break
      default:
        break
    }
  }

  return (
    <LayoutGroup id={layoutGroupId}>
      <motion.nav
        layoutScroll
        aria-label="On this page"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onFocus={() => {
          hasFocusRef.current = true
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            hasFocusRef.current = false
          }
        }}
      >
        <ul className="relative">
          <span aria-hidden="true" className="absolute inset-y-0 -left-[5px] w-px bg-border" />
          {rows.map((row, index) => {
            const { heading } = row
            const isActive = heading.id === activeRowId
            const Chevron = row.isCollapsed ? ChevronRight : ChevronDown

            return (
              <li key={heading.id} className="relative">
                {isActive && (
                  <motion.span
                    layoutId="outline-rail-marker"
                    aria-hidden="true"
                    data-outline-marker=""
                    className="absolute -left-1.5 top-1.5 h-4 w-[3px] rounded-sm bg-foreground"
                    transition={reduceMotion ? NO_TRANSITION : RAIL_TRANSITION}
                  />
                )}
                <button
                  ref={(node) => {
                    if (node) rowRefs.current.set(heading.id, node)
                    else rowRefs.current.delete(heading.id)
                  }}
                  type="button"
                  tabIndex={index === safeFocusIndex ? 0 : -1}
                  className={cn(
                    'flex h-7 w-full items-center gap-1 rounded-md pr-2 text-left text-xs transition-colors duration-150 ease-out',
                    FOCUS_RING_CLASS,
                    getDepthToneClass(row.depth),
                    isActive
                      ? 'keycap text-foreground'
                      : 'hover:bg-foreground/[0.03] hover:text-foreground'
                  )}
                  style={{ paddingLeft: getRowPaddingLeft(row.depth) }}
                  onClick={() => onHeadingClick(heading)}
                  onFocus={() => setFocusIndex(index)}
                  onKeyDown={(event) => handleKeyDown(event, index, row)}
                  title={heading.text}
                  aria-current={isActive ? 'location' : undefined}
                  aria-expanded={row.hasChildren ? !row.isCollapsed : undefined}
                >
                  <span className="flex size-3 shrink-0 items-center justify-center">
                    {row.hasChildren && (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: ArrowLeft/Right on the row toggle collapse
                      // biome-ignore lint/a11y/noStaticElementInteractions: nested in the row button; keyboard path is on the row
                      <span
                        data-outline-toggle=""
                        className="flex size-3 items-center justify-center text-muted-foreground hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation()
                          onToggleCollapsed(row.key)
                        }}
                      >
                        <Chevron size={12} />
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{heading.text}</span>
                  {row.isCollapsed && row.hiddenCount > 0 && (
                    <span className="shrink-0 text-2xs font-normal text-muted-foreground/60 tabular-nums">
                      {row.hiddenCount}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </motion.nav>
    </LayoutGroup>
  )
}
