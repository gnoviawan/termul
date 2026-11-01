import { type ReactNode, useCallback, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Camera, FileText, ImageIcon, Plus, Server } from '@/components/icons'
import {
  MobileSheetContent,
  SheetGroup,
  SheetIconWell,
  SheetRow,
  useSheetSubview
} from '@/components/ui/mobile-sheet'
import { Sheet, SheetTrigger } from '@/components/ui/sheet'
import type { AttachmentPickOptions } from '@/lib/composer-attachments-io'
import { logFrontendError } from '@/lib/log-api'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { McpServerList, type McpServerListProps } from '../McpBadge'

/**
 * What the + sheet can ask of the composer. `ChatInputBar` owns the attachments
 * hook and the editor, so it hands these four capabilities down instead of the
 * sheet reaching into either.
 */
export interface ComposerAddHandle {
  /** Whether attaching is allowed (false while the session is closed). */
  canPick: boolean
  /** Whether a picked image can reach this agent (Camera and Photos). */
  canPickImages: boolean
  /** Open the file picker. Must be called synchronously from the tap handler. */
  pickFiles: (options?: AttachmentPickOptions) => Promise<void>
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

type AddSheetView = 'mcp'

const TILE =
  'flex h-24 flex-col items-center justify-center gap-2 rounded-2xl bg-foreground/[0.05] text-sm text-foreground transition-colors duration-150 ease-out enabled:active:bg-foreground/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-disabled-foreground'

function AttachTile({
  icon,
  label,
  disabled,
  onClick
}: {
  icon: ReactNode
  label: string
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" className={TILE} disabled={disabled} onClick={onClick}>
      <SheetIconWell>{icon}</SheetIconWell>
      {label}
    </button>
  )
}

function mcpSummary(servers: McpServerListProps['servers']): string {
  if (servers.length === 0) return 'None added'
  const on = servers.filter((server) => server.enabled).length
  return `${on} of ${servers.length} on`
}

/**
 * Mobile composer "Add to chat" bottom sheet: the + button and its sheet.
 * Camera, Photos and Files attach; Mention a file and Commands start a token in
 * the draft; MCP servers opens a sub-view with the server switches. The agent,
 * model and chat options live in the model pill's own sheet.
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
  const sub = useSheetSubview<AddSheetView>('composer-add-sheet', open)
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
  //
  // A closed sheet stays mounted until its exit animation ends, so a second tap
  // (a double-tap) can still reach these rows: `open` is already false then, and
  // the guards below make that tap a no-op instead of a second insert or picker.
  const onTrigger = (trigger: '@' | '/'): void => {
    if (!open) return
    keepEditorFocusRef.current = true
    flushSync(() => setOpen(false))
    if (!handle.insertTrigger(trigger)) keepEditorFocusRef.current = false
  }

  // The picker has to open from this tap (browsers require user activation), so
  // call it before closing the sheet. Focus then returns to +.
  const onAttach = (options?: AttachmentPickOptions): void => {
    if (!open) return
    Promise.resolve(handle.pickFiles(options)).catch((err: unknown) => {
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
          className="relative inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-foreground transition-colors duration-150 ease-out after:absolute after:-inset-0.5 after:content-[''] hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={handle.blurEditor}
        >
          <Plus size={18} />
        </button>
      </SheetTrigger>
      <MobileSheetContent
        title={sub.view === 'mcp' ? 'MCP servers' : 'Add to chat'}
        onBack={sub.view ? sub.back : undefined}
        view={sub.view}
        aria-describedby={undefined}
        onEscapeKeyDown={sub.onEscapeKeyDown}
        onCloseAutoFocus={(event) => {
          if (!keepEditorFocusRef.current) return
          event.preventDefault()
          keepEditorFocusRef.current = false
        }}
      >
        {sub.view === 'mcp' ? (
          <div className="rounded-2xl bg-foreground/[0.05] px-4 py-3 text-xs">
            {/* The sheet scrolls itself, so lift the popover's nested 300px scroller.
                `max-h-fit` rather than `max-h-none`: tailwind-merge 2.x does not know
                `max-h-none`, so it would leave `max-h-[300px]` in place. */}
            <McpServerList {...mcp} listClassName="max-h-fit overflow-visible pr-0" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <AttachTile
                icon={<Camera size={18} />}
                label="Camera"
                disabled={!handle.canPickImages}
                onClick={() => onAttach({ accept: 'image/*', capture: 'environment' })}
              />
              <AttachTile
                icon={<ImageIcon size={18} />}
                label="Photos"
                disabled={!handle.canPickImages}
                onClick={() => onAttach({ accept: 'image/*' })}
              />
              <AttachTile
                icon={<FileText size={18} />}
                label="Files"
                disabled={!handle.canPick}
                onClick={() => onAttach()}
              />
            </div>
            <SheetGroup>
              <SheetRow
                icon={<SheetIconWell>@</SheetIconWell>}
                title="Mention a file"
                subtitle="Attach project files as context"
                disabled={disabled}
                onSelect={() => onTrigger('@')}
              />
              <SheetRow
                icon={<SheetIconWell>/</SheetIconWell>}
                title="Commands"
                subtitle="Agent commands and skills"
                disabled={disabled}
                onSelect={() => onTrigger('/')}
              />
            </SheetGroup>
            <SheetGroup>
              <SheetRow
                icon={
                  <SheetIconWell>
                    <Server size={16} />
                  </SheetIconWell>
                }
                title="MCP servers"
                subtitle={mcpSummary(mcp.servers)}
                accessory="chevron"
                subview="mcp"
                onSelect={() => sub.open('mcp')}
              />
            </SheetGroup>
          </>
        )}
      </MobileSheetContent>
    </Sheet>
  )
}
