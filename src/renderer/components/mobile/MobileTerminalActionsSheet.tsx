import { useEffect, useRef, useState } from 'react'
import { History, Pencil, RotateCcw, X } from '@/components/icons'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'

export const MOBILE_TERMINAL_ACTIONS_SHEET_ID = 'mobile-terminal-actions-sheet'

const ROW_CLASS_NAME = 'flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-sm'

interface MobileTerminalActionsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  terminalId: string
  tabId: string
  /** The terminal name, shown as the sheet title and the rename starting value. */
  name: string
  /** Exit code of the last command; the description shows only when it is a number. */
  lastExitCode?: number | null
  /** Returns focus per the shell's registry (`sheetCloseAutoFocus`, `lib/sheet-focus-return.ts`). */
  onCloseAutoFocus: (event: Event) => void
  /** Called when a row was chosen: the shell sets the destination title as the focus target. */
  onItemChosen: () => void
  /** Each row renders only when its callback is given. */
  onRenameTerminal?: (terminalId: string, name: string) => void
  onRestartTerminal?: (terminalId: string) => void
  onOpenCommandHistory?: () => void
  onCloseTerminal?: (terminalId: string, tabId: string) => void
}

/**
 * Terminal ⋯ bottom sheet: rename (the inline input moved here), restart,
 * command history and close. The drawer keeps its own rename pencil. Rows use
 * the `MobileFileExplorer` action-row pattern at 44px.
 */
export function MobileTerminalActionsSheet({
  open,
  onOpenChange,
  terminalId,
  tabId,
  name,
  lastExitCode,
  onCloseAutoFocus,
  onItemChosen,
  onRenameTerminal,
  onRestartTerminal,
  onOpenCommandHistory,
  onCloseTerminal
}: MobileTerminalActionsSheetProps): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  // Set once an edit is committed or cancelled, so the blur that follows (the
  // sheet closing, or Escape) cannot commit a second time or revive a cancel.
  const settledRef = useRef(true)

  useEffect(() => {
    if (!open) setRenaming(false)
  }, [open])

  const startRename = (): void => {
    settledRef.current = false
    setDraft(name)
    setRenaming(true)
  }

  /** Ends the edit; returns the new name when there is one to apply. */
  const settleRename = (): string | null => {
    if (settledRef.current) return null
    settledRef.current = true
    setRenaming(false)
    const next = draft.trim()
    return next.length > 0 ? next : null
  }

  const commitRename = (): boolean => {
    const next = settleRename()
    if (next === null || !onRenameTerminal) return false
    onRenameTerminal(terminalId, next)
    return true
  }

  const choose = (run: () => void) => (): void => {
    onItemChosen()
    onOpenChange(false)
    run()
  }

  const hasExitCode = typeof lastExitCode === 'number'

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        id={MOBILE_TERMINAL_ACTIONS_SHEET_ID}
        // No description to point at before a command has exited.
        {...(hasExitCode ? {} : { 'aria-describedby': undefined })}
        onCloseAutoFocus={onCloseAutoFocus}
        className="flex max-h-[85dvh] flex-col gap-0 overflow-y-auto overscroll-contain p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="space-y-0 px-2 py-2 pr-10 text-left">
          <SheetTitle className="truncate text-base">{name}</SheetTitle>
          {hasExitCode && (
            <SheetDescription className="text-xs tabular-nums text-muted-foreground">
              Last exit code {lastExitCode}
            </SheetDescription>
          )}
        </SheetHeader>
        {onRenameTerminal &&
          (renaming ? (
            // No vertical padding: the edit row is exactly as tall as the
            // action rows, so ending the edit (a tap on another row blurs the
            // input) does not shift the rows below out from under the finger.
            <div className="px-2">
              <Input
                autoFocus
                value={draft}
                aria-label={`Rename ${name}`}
                className="min-h-11 text-base md:text-base"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    // Enter that confirms an IME or predictive-text composition
                    // is not a commit. Safari fires compositionend before the
                    // keydown, so `isComposing` is already false there and only
                    // the legacy keyCode 229 marks it.
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return
                    // Blank keeps the sheet open; a real rename closes it.
                    if (commitRename()) onOpenChange(false)
                  } else if (event.key === 'Escape') {
                    // Radix closes the sheet on Escape; just drop the edit.
                    settledRef.current = true
                    setRenaming(false)
                  }
                }}
                onBlur={() => {
                  commitRename()
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              className={`${ROW_CLASS_NAME} hover:bg-accent`}
              onClick={startRename}
            >
              <Pencil size={16} />
              Rename terminal
            </button>
          ))}
        {onRestartTerminal && (
          <button
            type="button"
            className={`${ROW_CLASS_NAME} hover:bg-accent`}
            onClick={choose(() => onRestartTerminal(terminalId))}
          >
            <RotateCcw size={16} />
            Restart terminal
          </button>
        )}
        {onOpenCommandHistory && (
          <button
            type="button"
            className={`${ROW_CLASS_NAME} hover:bg-accent`}
            onClick={choose(onOpenCommandHistory)}
          >
            <History size={16} />
            Command history
          </button>
        )}
        {onCloseTerminal && (
          <button
            type="button"
            className={`${ROW_CLASS_NAME} text-destructive hover:bg-destructive/10`}
            onClick={choose(() => onCloseTerminal(terminalId, tabId))}
          >
            <X size={16} />
            Close terminal
          </button>
        )}
      </SheetContent>
    </Sheet>
  )
}
