import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, Pencil, RotateCcw } from '@/components/icons'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { IconActionButton } from '@/components/ui/icon-action-button'
import { IconSwap } from '@/components/ui/icon-swap'
import { copyText } from '@/lib/copy-text'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'

/**
 * How a message's actions are exposed.
 * - `desktop`: today's behaviour (the row, hover-revealed on fine pointers).
 * - `focus-reveal`: mobile shell. The row is hidden at rest and shown on
 *   keyboard focus; a long-press / context-menu key opens `MessageActionsContextMenu`.
 * - `visible-fallback`: mobile shell where long-press cannot work; the row
 *   renders as it does on desktop/touch today so the actions stay reachable.
 */
export type MessageActionsMode = 'desktop' | 'focus-reveal' | 'visible-fallback'

/**
 * Feature-detect the one capability Radix's long-press depends on and that we
 * can observe: Pointer Events. Without it the 700ms touch timer never arms.
 */
export function supportsLongPressMenu(): boolean {
  return typeof window !== 'undefined' && typeof window.PointerEvent === 'function'
}

/** Pick the actions mode from the shell and the long-press capability. */
export function resolveMessageActionsMode(
  isMobileShell: boolean,
  longPressSupported: boolean
): MessageActionsMode {
  if (!isMobileShell) return 'desktop'
  return longPressSupported ? 'focus-reveal' : 'visible-fallback'
}

let longPressFallbackLogged = false

/**
 * Log once per page load that the mobile shell fell back to the always-visible
 * `MessageActions` row. Never carries message text.
 */
export function logLongPressFallbackOnce(): void {
  if (longPressFallbackLogged) return
  longPressFallbackLogged = true
  void logFrontendError({
    level: 'info',
    source: 'MessageActions.fallback',
    message: 'long-press unsupported, MessageActions shown'
  })
}

/** Test-only: re-arm the once-per-page-load fallback log. */
export function resetLongPressFallbackLogForTests(): void {
  longPressFallbackLogged = false
}

/**
 * Clipboard copy shared by the action row and the context menu.
 *
 * Empty text is a silent no-op (resolves `true`: there was nothing to fail).
 * A clipboard failure shows the "Failed to copy" toast and resolves `false`.
 * `copied` is true for 1.5s after a successful copy.
 */
export function useMessageCopy(text: string): {
  copied: boolean
  copy: () => Promise<boolean>
} {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async (): Promise<boolean> => {
    if (!text) return true
    const ok = await copyText(text)
    if (!ok) {
      toast.error('Failed to copy')
      return false
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
    return true
  }, [text])

  return { copied, copy }
}

interface MessageActionsProps {
  /** Plain text to place on the clipboard for the copy action. */
  text: string
  align: 'start' | 'end'
  /** Keep actions visible without hover (e.g. last message in thread). */
  pinned?: boolean
  /**
   * `hover` (default): today's behaviour. `focus`: hidden at rest on touch and
   * shown while the message or the row has keyboard focus (ignores `pinned`).
   */
  reveal?: 'hover' | 'focus'
  /** Edit the message (e.g. seed the composer with this text). */
  onEdit?: () => void
  /** Re-run the turn (regenerate the response). */
  onRetry?: () => void
  className?: string
}

/**
 * Toolbar for a chat message — copy, plus optional edit (user turns) and
 * retry (assistant turns). Fine-pointer: hover-revealed (pinned stays visible).
 * Coarse pointer / touch: always soft-visible so actions stay discoverable,
 * unless `reveal="focus"` (mobile shell), where the row stays mounted but is
 * transparent and inert at rest and appears on keyboard focus.
 * No action pill: icons flush with prose left edge (assistant) / bubble (user).
 */
export function MessageActions({
  text,
  align,
  pinned = false,
  reveal = 'hover',
  onEdit,
  onRetry,
  className
}: MessageActionsProps): React.JSX.Element {
  const { copied, copy } = useMessageCopy(text)

  return (
    <div
      className={cn(
        // Compact icon row; the gap keeps the ~44px pseudo-element hit
        // areas (#859) close to tiling without dead space.
        'flex items-center gap-2.5 transition-opacity duration-150 focus-within:opacity-100',
        reveal === 'focus'
          ? // Hidden and inert at rest so a tap cannot land on an invisible
            // action. Keyboard focus (message or inside the row) reveals it.
            'pointer-events-none opacity-0 focus-within:pointer-events-auto group-focus-visible/message:pointer-events-auto group-focus-visible/message:opacity-100 pointer-fine:group-hover/message:pointer-events-auto pointer-fine:group-hover/message:opacity-100'
          : // Touch / coarse: always visible. Fine pointer: hover-reveal unless pinned.
            pinned
            ? 'opacity-100'
            : 'opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover/message:opacity-100',
        align === 'start' && '-ml-1',
        align === 'end' && 'justify-end -mr-1',
        className
      )}
    >
      <div className={cn('flex items-center gap-2.5', align === 'end' && 'flex-row-reverse')}>
        <IconActionButton
          size="sm"
          label={copied ? 'Copied' : 'Copy'}
          onClick={() => void copy()}
          className="rounded-md hover:bg-secondary/60 active:scale-[0.96] transition-[transform,color,background-color] duration-150"
        >
          <IconSwap iconKey={copied}>
            {copied ? <Check className="text-success" /> : <Copy />}
          </IconSwap>
        </IconActionButton>
        {onEdit && (
          <IconActionButton
            size="sm"
            label="Edit"
            onClick={onEdit}
            className="rounded-md hover:bg-secondary/60 active:scale-[0.96] transition-[transform,color,background-color] duration-150"
          >
            <Pencil />
          </IconActionButton>
        )}
        {onRetry && (
          <IconActionButton
            size="sm"
            label="Retry"
            onClick={onRetry}
            className="rounded-md hover:bg-secondary/60 active:scale-[0.96] transition-[transform,color,background-color] duration-150"
          >
            <RotateCcw />
          </IconActionButton>
        )}
      </div>
    </div>
  )
}

interface MessageActionsContextMenuProps {
  /** Overlay-stack id, unique per message, so system back closes the menu. */
  overlayId: string
  /** Copy text — the same string the `MessageActions` row copies. */
  text: string
  /** Present only when the row shows Edit; receives no arguments (the row's callback). */
  onEdit?: () => void
  /** Present only when the row shows Retry. */
  onRetry?: () => void
  /**
   * Keep the wrapper mounted but inert: no menu, no long-press, and the native
   * / app-level context menu keeps working. Lets a message gain or lose actions
   * (its stream settles, the turn tail moves) without remounting its subtree.
   */
  disabled?: boolean
  /** The message element. It becomes the context-menu trigger (`asChild`). */
  children: React.ReactElement
}

/**
 * Props that strip everything Radix's trigger adds to its child when disabled
 * (`data-state`, `data-disabled`, `-webkit-touch-callout: none`), so an inert
 * wrapper leaves the message DOM as it was without one.
 */
const INERT_TRIGGER_PROPS = {
  'data-state': undefined,
  'data-disabled': undefined,
  style: { WebkitTouchCallout: undefined }
}

/**
 * Long-press / right-click / context-menu-key menu for a message on the mobile
 * shell. Items mirror the `MessageActions` row exactly (Copy, then Edit or
 * Retry) and call the row's callbacks.
 *
 * Accepted trade-offs of making the whole message the trigger:
 * - No native long-press text selection on touch. A partial copy goes through
 *   Copy, which always copies the whole message, or through the code-block /
 *   expanded `ToolCallCard` copy buttons.
 * - Radix sets `-webkit-touch-callout: none` on the trigger, so the iOS link
 *   preview and "save image" long-press callouts are unavailable inside a
 *   message that has actions.
 * - The trigger also owns right-click. The mobile shell is chosen by viewport
 *   size (narrow, or a short landscape viewport; never under Tauri), not
 *   pointer type, so with a mouse in such a window a right-click on such a
 *   message opens this menu instead of the app-level Copy / Cut / Paste /
 *   Select All menu.
 *
 * Pointer and contextmenu events that reach the trigger from a React portal
 * (the link-safety dialog, the image lightbox, a fullscreen table) are ignored:
 * they bubble through React but are not on the message, so they never open the
 * menu. Radix's trigger still cancels the default of a right-click from such a
 * source, so neither the native nor the app-level menu shows inside the portal.
 *
 * The menu is a controlled Radix `ContextMenu` registered with the overlay
 * stack, so system back closes it. Focus returns to the previously focused
 * element on close (Radix default), except after Edit, where the composer seed
 * owns focus.
 */
export function MessageActionsContextMenu({
  overlayId,
  text,
  onEdit,
  onRetry,
  disabled = false,
  children
}: MessageActionsContextMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { copy } = useMessageCopy(text)
  const closedByEditRef = useRef(false)
  const fromPortalRef = useRef(false)

  const close = useCallback(() => setOpen(false), [])
  useOverlayRegistration(overlayId, open, close)

  // The message stopped owning actions while its menu was open: close it.
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  // Radix arms its long-press timer from the trigger's `pointerdown`, which also
  // receives portaled descendants' events. Record where the latest one came
  // from and refuse to open for a portaled source.
  const markEventOrigin = useCallback((event: React.SyntheticEvent<HTMLElement>) => {
    fromPortalRef.current = !event.currentTarget.contains(event.target as Node)
  }, [])

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) {
      if (fromPortalRef.current) return
      // A stale flag (Edit that never reached `onCloseAutoFocus`) must not
      // suppress the focus return of a later close.
      closedByEditRef.current = false
    }
    setOpen(next)
  }, [])

  const handleCopy = useCallback(async () => {
    const ok = await copy()
    if (ok) return
    // The toast is shown by useMessageCopy. Log without the message text.
    void logFrontendError({
      level: 'warn',
      source: 'MessageActions.contextMenu',
      message: 'Failed to copy message text from the actions menu'
    })
  }, [copy])

  return (
    <ContextMenu open={open} onOpenChange={handleOpenChange}>
      <ContextMenuTrigger
        asChild
        disabled={disabled}
        onPointerDownCapture={markEventOrigin}
        onContextMenuCapture={markEventOrigin}
        {...(disabled ? INERT_TRIGGER_PROPS : undefined)}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          // After Edit the composer seed focuses the editor; Radix's default
          // focus return would steal it back.
          if (!closedByEditRef.current) return
          closedByEditRef.current = false
          event.preventDefault()
        }}
      >
        <ContextMenuItem onSelect={() => void handleCopy()}>
          <Copy className="mr-2 h-4 w-4" /> Copy
        </ContextMenuItem>
        {onEdit && (
          <ContextMenuItem
            onSelect={() => {
              closedByEditRef.current = true
              onEdit()
            }}
          >
            <Pencil className="mr-2 h-4 w-4" /> Edit
          </ContextMenuItem>
        )}
        {onRetry && (
          <ContextMenuItem onSelect={() => onRetry()}>
            <RotateCcw className="mr-2 h-4 w-4" /> Retry
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
