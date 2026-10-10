import { Trash2, X } from '@/components/icons'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { SHEET_DESTRUCTIVE_DIVIDER_CLASS_NAME, SHEET_ROW_CLASS_NAME } from './mobile-sheet-rows'

export const MOBILE_RECENTS_ACTIONS_SHEET_ID = 'mobile-recents-actions-sheet'

interface MobileRecentsActionsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The chat's title, so the sheet makes sense on its own. */
  title: string
  /** Open chats only: closes the chat through its guarded close. */
  onCloseChat?: () => void
  /** History chats only: requests the existing delete confirm. */
  onDeleteChat?: () => void
  /** Places focus once the sheet has closed (back on its row). */
  onCloseAutoFocus: (event: Event) => void
}

/**
 * The Recents row actions, opened by a long-press (`contextmenu`) or the row's
 * keyboard-reachable actions button: Close for an open chat, Delete for a
 * history chat. Recents rows carry no trailing icons of their own.
 */
export function MobileRecentsActionsSheet({
  open,
  onOpenChange,
  title,
  onCloseChat,
  onDeleteChat,
  onCloseAutoFocus
}: MobileRecentsActionsSheetProps): React.JSX.Element {
  // System back closes this sheet before the drawer under it.
  useOverlayRegistration(MOBILE_RECENTS_ACTIONS_SHEET_ID, open, () => onOpenChange(false))

  const choose = (run: () => void) => (): void => {
    onOpenChange(false)
    run()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        id={MOBILE_RECENTS_ACTIONS_SHEET_ID}
        onCloseAutoFocus={onCloseAutoFocus}
        className="flex max-h-[85dvh] flex-col gap-0 overflow-y-auto overscroll-contain p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="space-y-0 px-2 py-2 pr-10 text-left">
          <SheetTitle className="truncate text-base">{title}</SheetTitle>
          <SheetDescription className="sr-only">Chat actions</SheetDescription>
        </SheetHeader>
        {onCloseChat && (
          <button
            type="button"
            className={`${SHEET_ROW_CLASS_NAME} hover:bg-accent`}
            onClick={choose(onCloseChat)}
          >
            <X size={16} />
            Close chat
          </button>
        )}
        {onDeleteChat && (
          <div className={onCloseChat ? SHEET_DESTRUCTIVE_DIVIDER_CLASS_NAME : undefined}>
            <button
              type="button"
              className={`${SHEET_ROW_CLASS_NAME} text-destructive hover:bg-destructive/10`}
              onClick={choose(onDeleteChat)}
            >
              <Trash2 size={16} />
              Delete chat
            </button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
