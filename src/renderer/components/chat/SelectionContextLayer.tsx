import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BlockQuote } from '@/components/icons'
import { Kbd } from '@/components/ui/kbd'
import { createSelectionContext, type SelectionContext } from '@/lib/composer/selection-context'
import { logFrontendError } from '@/lib/log-api'
import { isMac } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { matchesShortcut, useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { iconPop } from './chat-motion'

/** Marks an element whose text can become a selection context (user and agent bubbles). */
const SOURCE_SELECTOR = '[data-selection-context-source]'
const CODE_BODY_SELECTOR = '[data-streamdown="code-block-body"]'
const SHORTCUT_LABEL = isMac ? '⌘L' : 'Ctrl+L'
const BUTTON_HEIGHT = 32
const BUTTON_GAP = 6
/** About half the button width plus a margin: keeps the centred button inside the list. */
const EDGE_INSET = 90

interface MessageSelection {
  context: SelectionContext
  /** Button anchor, relative to the layer: the horizontal centre and the top of the selection. */
  x: number
  top: number
  bottom: number
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

/**
 * The current document selection when both of its ends are inside chat
 * messages of `root`, else null. A selection inside one code block keeps the
 * block's language.
 */
function readMessageSelection(root: HTMLElement): MessageSelection | null {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const start = elementOf(range.startContainer)
  const end = elementOf(range.endContainer)
  if (!start || !end || !root.contains(start) || !root.contains(end)) return null
  const startSource = start.closest(SOURCE_SELECTOR)
  const endSource = end.closest(SOURCE_SELECTOR)
  if (!startSource || !endSource || !root.contains(startSource) || !root.contains(endSource)) {
    return null
  }
  if (start.closest('[contenteditable="true"]') || end.closest('[contenteditable="true"]')) {
    return null
  }
  const codeBody = start.closest(CODE_BODY_SELECTOR)
  const language =
    codeBody && codeBody === end.closest(CODE_BODY_SELECTOR)
      ? (codeBody.getAttribute('data-language') ?? '')
      : undefined
  const context = createSelectionContext(selection.toString(), language)
  if (!context) return null
  // jsdom has no Range#getBoundingClientRect; the start element is a fine fallback.
  const rect =
    typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : start.getBoundingClientRect()
  const layer = root.getBoundingClientRect()
  const centre = rect.left + rect.width / 2 - layer.left
  return {
    context,
    x:
      layer.width > EDGE_INSET * 2
        ? Math.min(Math.max(centre, EDGE_INSET), layer.width - EDGE_INSET)
        : centre,
    top: rect.top - layer.top,
    bottom: rect.bottom - layer.top
  }
}

function isAddShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 'l' || event.shiftKey || event.altKey) return false
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

function isBoundAppShortcut(event: KeyboardEvent): boolean {
  const { shortcuts } = useKeyboardShortcutsStore.getState()
  return Object.values(shortcuts).some((s) => matchesShortcut(event, s.customKey ?? s.defaultKey))
}

interface SelectionContextLayerProps {
  /** Adds the selection to the composer. Without it the layer is a plain container. */
  onAdd?: (context: SelectionContext) => void
  className?: string
  children: React.ReactNode
}

/**
 * Container for the message list that turns selected message text into a
 * selection context. With a pointer selection it floats an "Add to context"
 * button near the selection; Cmd+L (macOS) / Ctrl+L (other) adds the
 * selection from the keyboard. Touch selections get no floating button (the
 * OS selection menu owns that space), but the shortcut still works.
 */
export function SelectionContextLayer({
  onAdd,
  className,
  children
}: SelectionContextLayerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion() ?? false
  const [current, setCurrent] = useState<MessageSelection | null>(null)
  const pointerRef = useRef<{ down: boolean; type: string }>({ down: false, type: 'mouse' })
  const enabled = onAdd !== undefined

  const refresh = useCallback(() => {
    const root = rootRef.current
    const pointer = pointerRef.current
    if (!root || pointer.down || pointer.type === 'touch') {
      setCurrent(null)
      return
    }
    setCurrent(readMessageSelection(root))
  }, [])

  const add = useCallback(
    (selection: MessageSelection | null, via: 'button' | 'shortcut'): boolean => {
      if (!selection || !onAdd) return false
      onAdd(selection.context)
      document.getSelection()?.removeAllRanges()
      setCurrent(null)
      void logFrontendError({
        level: 'info',
        source: 'SelectionContextLayer',
        message: `Selection context requested via ${via}`
      })
      return true
    },
    [onAdd]
  )

  useEffect(() => {
    if (!enabled) return
    const root = rootRef.current
    if (!root) return
    let frame = 0
    const schedule = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(refresh)
    }
    const onPointerDown = (event: PointerEvent): void => {
      // A press on the button itself must not hide it before its click lands.
      if ((event.target as Element | null)?.closest?.('[data-selection-context-add]')) return
      pointerRef.current = { down: true, type: event.pointerType || 'mouse' }
      setCurrent(null)
    }
    const onPointerUp = (event: PointerEvent): void => {
      if (!pointerRef.current.down) return
      pointerRef.current = { down: false, type: event.pointerType || pointerRef.current.type }
      schedule()
    }
    const onSelectionChange = (): void => {
      if (pointerRef.current.down) return
      refresh()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isAddShortcut(event) || isBoundAppShortcut(event)) return
      const rootNow = rootRef.current
      if (!rootNow || !add(readMessageSelection(rootNow), 'shortcut')) return
      event.preventDefault()
      event.stopPropagation()
    }
    root.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('keydown', onKeyDown)
    root.addEventListener('scroll', schedule, true)
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('keydown', onKeyDown)
      root.removeEventListener('scroll', schedule, true)
    }
  }, [enabled, refresh, add])

  const pop = iconPop(reduced)
  const placeBelow = current !== null && current.top < BUTTON_HEIGHT + BUTTON_GAP
  return (
    <div ref={rootRef} className={className}>
      {children}
      <AnimatePresence>
        {enabled && current && (
          <motion.div
            key="add-to-context"
            className="pointer-events-none absolute z-30"
            style={{
              left: current.x,
              x: '-50%',
              top: placeBelow
                ? current.bottom + BUTTON_GAP
                : current.top - BUTTON_HEIGHT - BUTTON_GAP
            }}
            initial={pop.initial}
            animate={pop.animate}
            exit={pop.exit}
            transition={pop.transition}
          >
            <button
              type="button"
              data-selection-context-add=""
              aria-label="Add to context"
              title={`Add to context (${SHORTCUT_LABEL})`}
              // Keep the selection: a mousedown on the button would collapse it.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => add(current, 'button')}
              className={cn(
                'pointer-events-auto inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border',
                'bg-popover px-2.5 text-xs font-medium text-popover-foreground shadow-md',
                'transition-colors hover:bg-foreground/[0.06]',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
            >
              <BlockQuote size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>Add to context</span>
              <Kbd className="px-1 py-px">{SHORTCUT_LABEL}</Kbd>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
