import { useCallback, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Paperclip, Plus } from '@/components/icons'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { SELECTOR_SECTION_LABEL } from '../AgentHeader'
import { CHAT_HIT_ICON } from '../chat-layout'
import { McpServerList, type McpServerListProps } from '../McpBadge'

/**
 * What the + sheet can ask of the composer. `ChatInputBar` owns the attachments
 * hook and the editor, so it hands these four capabilities down instead of the
 * sheet reaching into either.
 */
export interface ComposerAddHandle {
  /** Whether attaching is allowed (false while the session is closed). */
  canPick: boolean
  /** Open the file picker. Must be called synchronously from the tap handler. */
  pickFiles: () => Promise<void>
  /** Append `@` / `/` to the draft; false when the editor is unavailable. */
  insertTrigger: (trigger: '@' | '/') => boolean
  /** Blur the editor synchronously (dismisses the on-screen keyboard). */
  blurEditor: () => void
}

interface ComposerAddSheetProps extends Omit<McpServerListProps, 'listClassName'> {
  handle: ComposerAddHandle
  /** Session closed: the editor is unavailable. */
  disabled: boolean
}

const LOG_SOURCE = 'composer-add-sheet'

/** `MobileFileExplorer` action-row pattern; `min-h-11` holds the 44px touch floor. */
const ACTION_ROW =
  'flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:text-disabled-foreground disabled:hover:bg-transparent'

/** `@` and `/` are text glyphs: the icon set has no AtSign or Slash. */
function TriggerGlyph({ children }: { children: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-4 shrink-0 items-center justify-center text-sm font-medium"
    >
      {children}
    </span>
  )
}

/**
 * Mobile composer "Add to chat" bottom sheet: the + button and its sheet. Holds
 * the actions that no longer fit the one-row toolbar: attach files, mention a
 * file, run a command, and the MCP servers. The agent, model, effort and the
 * other chat options live in the model selector pill next to it, which opens
 * its own bottom sheet on the mobile shell.
 */
export function ComposerAddSheet({
  handle,
  disabled,
  ...mcp
}: ComposerAddSheetProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Set while a Mention/Commands tap hands focus to the editor, so the sheet's
  // own focus restore (back to +) does not steal it again.
  const keepEditorFocusRef = useRef(false)
  const close = useCallback(() => setOpen(false), [])
  useOverlayRegistration('composer-add-sheet', open, close)
  const onOpenChange = useCallback((next: boolean) => {
    // A fresh open never inherits a stale "keep focus in the editor" flag, so a
    // later Escape, ✕ or system-back dismissal always restores focus to +.
    if (next) keepEditorFocusRef.current = false
    setOpen(next)
  }, [])

  // Radix's FocusScope pulls focus back into the sheet while it is open, so
  // focusing the editor first would bounce straight back. Close synchronously to
  // release the trap, then focus the editor in the same tap so iOS raises the
  // keyboard.
  const onTrigger = (trigger: '@' | '/'): void => {
    keepEditorFocusRef.current = true
    flushSync(() => setOpen(false))
    if (!handle.insertTrigger(trigger)) keepEditorFocusRef.current = false
  }

  // The picker has to open from this tap (browsers require user activation), so
  // call it before closing the sheet. Focus then returns to +.
  const onAttach = (): void => {
    Promise.resolve(handle.pickFiles()).catch((err: unknown) => {
      void logFrontendError({
        level: 'warn',
        source: LOG_SOURCE,
        message: `Attach files failed: ${err instanceof Error ? err.name : 'unknown error'}`
      })
    })
    setOpen(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Add to chat"
          className={cn(
            CHAT_HIT_ICON,
            'rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
          onClick={handle.blurEditor}
        >
          <Plus size={18} />
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        aria-describedby={undefined}
        className="flex max-h-[85dvh] flex-col gap-0 overflow-y-auto overscroll-contain p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        onCloseAutoFocus={(event) => {
          if (!keepEditorFocusRef.current) return
          event.preventDefault()
          keepEditorFocusRef.current = false
        }}
      >
        <SheetHeader className="space-y-0 px-2 py-2 pr-10 text-left">
          <SheetTitle className="text-base">Add to chat</SheetTitle>
        </SheetHeader>
        {handle.canPick && (
          <button type="button" className={ACTION_ROW} onClick={onAttach}>
            <Paperclip size={16} /> Attach files
          </button>
        )}
        <button
          type="button"
          className={ACTION_ROW}
          disabled={disabled}
          onClick={() => onTrigger('@')}
        >
          <TriggerGlyph>@</TriggerGlyph> Mention file
        </button>
        <button
          type="button"
          className={ACTION_ROW}
          disabled={disabled}
          onClick={() => onTrigger('/')}
        >
          <TriggerGlyph>/</TriggerGlyph> Commands
        </button>
        <h3 className={cn(SELECTOR_SECTION_LABEL, 'mt-2')}>MCP servers</h3>
        <div className="px-2 pb-2 text-xs">
          {/* The sheet scrolls itself, so lift the popover's nested 300px scroller.
              `max-h-fit` rather than `max-h-none`: tailwind-merge 2.x does not know
              `max-h-none`, so it would leave `max-h-[300px]` in place. */}
          <McpServerList {...mcp} listClassName="max-h-fit overflow-visible pr-0" />
        </div>
      </SheetContent>
    </Sheet>
  )
}
