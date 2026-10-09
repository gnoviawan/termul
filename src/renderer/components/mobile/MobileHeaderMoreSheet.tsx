import { X } from '@/components/icons'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import {
  SHEET_DESTRUCTIVE_DIVIDER_CLASS_NAME,
  SHEET_ROW_CLASS_NAME,
  type ShellNavigationActions,
  visibleNavigationRows
} from './mobile-sheet-rows'

export const MOBILE_HEADER_MORE_SHEET_ID = 'mobile-header-more-sheet'

interface MobileHeaderMoreSheetProps extends ShellNavigationActions {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The header title, so the sheet makes sense on its own. */
  title: string
  /** The header subtitle text (project, branch, Local or Worktree). */
  subtitle: string
  /** Returns focus per the shell's registry (`sheetCloseAutoFocus`, `lib/sheet-focus-return.ts`). */
  onCloseAutoFocus: (event: Event) => void
  /** Called when a row was chosen: the shell sets the destination title as the focus target. */
  onItemChosen: () => void
  /** Agent-chat tabs only. */
  onCloseChat?: () => void
}

/**
 * Header ⋯ bottom sheet for a chat or tab: the actions the old header spread
 * across six icons. Each row calls its callback and closes the sheet. Rows use
 * the `MobileFileExplorer` action-row pattern at 44px.
 */
export function MobileHeaderMoreSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  onCloseAutoFocus,
  onItemChosen,
  onCloseChat,
  ...navigation
}: MobileHeaderMoreSheetProps): React.JSX.Element {
  const choose = (run: () => void) => (): void => {
    onItemChosen()
    onOpenChange(false)
    run()
  }

  // Each row renders only when its callback is given.
  const visibleRows = visibleNavigationRows(navigation)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        id={MOBILE_HEADER_MORE_SHEET_ID}
        onCloseAutoFocus={onCloseAutoFocus}
        className="flex max-h-[85dvh] flex-col gap-0 overflow-y-auto overscroll-contain p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="space-y-0 px-2 py-2 pr-10 text-left">
          <SheetTitle className="truncate text-base">{title}</SheetTitle>
          <SheetDescription className="truncate text-xs text-muted-foreground">
            {subtitle}
          </SheetDescription>
        </SheetHeader>
        {visibleRows.map(({ label, Icon, run }) => (
          <button
            key={label}
            type="button"
            className={`${SHEET_ROW_CLASS_NAME} hover:bg-accent`}
            onClick={choose(run)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
        {onCloseChat && (
          <div
            className={visibleRows.length > 0 ? SHEET_DESTRUCTIVE_DIVIDER_CLASS_NAME : undefined}
          >
            <button
              type="button"
              className={`${SHEET_ROW_CLASS_NAME} text-destructive hover:bg-destructive/10`}
              onClick={choose(onCloseChat)}
            >
              <X size={16} />
              Close chat
            </button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
