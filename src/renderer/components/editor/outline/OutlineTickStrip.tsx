import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useRef, useState } from 'react'
import type { TocHeading } from '@/hooks/use-toc-headings'
import { cn } from '@/lib/utils'
import { getDepthToneClass, getRowPaddingLeft } from './OutlineList'
import { getMinHeadingLevel } from './outline-rows'

/** Tick width by depth: 14 / 10 / 6 px. */
export function getTickWidth(depth: number): number {
  if (depth <= 0) return 14
  if (depth === 1) return 10
  return 6
}

const CLOSE_DELAY_MS = 120

interface OutlineTickStripProps {
  headings: TocHeading[]
  activeHeadingId?: string
  onHeadingClick: (heading: TocHeading) => void
}

/**
 * Narrow-pane outline: one tick per heading at the right edge. Hover or
 * focus opens the full list as a popover to the left of the strip. A touch
 * tap on the strip opens the popover instead of jumping.
 */
export function OutlineTickStrip({
  headings,
  activeHeadingId,
  onHeadingClick
}: OutlineTickStripProps): React.JSX.Element | null {
  const reduceMotion = useReducedMotion()
  const [isOpen, setIsOpen] = useState(false)
  const closeTimerRef = useRef<number | undefined>(undefined)
  const lastPointerTypeRef = useRef<string>('mouse')

  if (headings.length === 0) {
    return null
  }

  const minLevel = getMinHeadingLevel(headings)

  const open = (): void => {
    window.clearTimeout(closeTimerRef.current)
    setIsOpen(true)
  }
  const scheduleClose = (): void => {
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => setIsOpen(false), CLOSE_DELAY_MS)
  }
  const jump = (heading: TocHeading): void => {
    onHeadingClick(heading)
    setIsOpen(false)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover/focus container that shows the popover
    <div
      data-outline-strip=""
      className="relative flex h-full w-7 shrink-0 flex-col items-end pt-4 pr-2"
      onPointerEnter={(event) => {
        lastPointerTypeRef.current = event.pointerType
        if (event.pointerType === 'mouse') open()
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') scheduleClose()
      }}
      onPointerDown={(event) => {
        lastPointerTypeRef.current = event.pointerType
      }}
      onFocus={open}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsOpen(false)
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setIsOpen(false)
      }}
    >
      <div className="flex flex-col items-end gap-1.5" aria-hidden="true">
        {headings.map((heading) => {
          const isActive = heading.id === activeHeadingId
          return (
            <button
              key={heading.id}
              type="button"
              tabIndex={-1}
              data-outline-tick=""
              className="flex h-2 items-center justify-end"
              onClick={() => {
                if (lastPointerTypeRef.current !== 'mouse' && !isOpen) {
                  open()
                  return
                }
                jump(heading)
              }}
            >
              <span
                className={cn(
                  'h-0.5 rounded-full transition-colors duration-150 ease-out',
                  isActive ? 'bg-foreground' : 'bg-muted-foreground/50'
                )}
                style={{ width: getTickWidth(heading.level - minLevel) }}
              />
            </button>
          )
        })}
      </div>

      <AnimatePresence>
        {isOpen && (
          <motion.nav
            aria-label="On this page"
            initial={reduceMotion ? false : { opacity: 0, x: 4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: 4 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute right-7 top-2 z-30 max-h-[70vh] w-56 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <ul>
              {headings.map((heading) => {
                const isActive = heading.id === activeHeadingId
                const depth = heading.level - minLevel
                return (
                  <li key={heading.id}>
                    <button
                      type="button"
                      className={cn(
                        'flex h-7 w-full items-center rounded-lg pr-2 text-left text-xs transition-colors duration-150 ease-out hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] focus-visible:outline-none',
                        getDepthToneClass(depth),
                        isActive && 'bg-foreground/[0.06] text-foreground'
                      )}
                      style={{ paddingLeft: getRowPaddingLeft(depth) + 2 }}
                      onClick={() => jump(heading)}
                      title={heading.text}
                      aria-current={isActive ? 'location' : undefined}
                    >
                      <span className="truncate">{heading.text}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </motion.nav>
        )}
      </AnimatePresence>

      {/* Keyboard entry: one tab stop that opens the popover on focus. */}
      <button
        type="button"
        className="sr-only focus:not-sr-only focus-visible:outline-none"
        aria-label="Show outline"
        aria-expanded={isOpen}
        onClick={open}
      />
    </div>
  )
}
