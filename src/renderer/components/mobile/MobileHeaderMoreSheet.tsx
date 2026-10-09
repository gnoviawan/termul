import { FolderTree, GitBranch, Search, Settings, TerminalSquare, X } from '@/components/icons'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'

export const MOBILE_HEADER_MORE_SHEET_ID = 'mobile-header-more-sheet'

const ROW_CLASS_NAME = 'flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-sm'

interface MobileHeaderMoreSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The header title, so the sheet makes sense on its own. */
  title: string
  /** The header subtitle text (project, branch, Local or Worktree). */
  subtitle: string
  /** Returns focus per the shell's focus rules (see `useSheetCloseFocus`). */
  onCloseAutoFocus: (event: Event) => void
  /** Marks that a row was chosen, so focus lands on the destination title. */
  onItemChosen: () => void
  /** Each row renders only when its callback is given. */
  onOpenGitChanges?: () => void
  onOpenFiles?: () => void
  onOpenCommandPalette?: () => void
  onNewTerminal?: () => void
  onOpenProjectSettings?: () => void
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
  onOpenGitChanges,
  onOpenFiles,
  onOpenCommandPalette,
  onNewTerminal,
  onOpenProjectSettings,
  onCloseChat
}: MobileHeaderMoreSheetProps): React.JSX.Element {
  const choose = (run: () => void) => (): void => {
    onItemChosen()
    onOpenChange(false)
    run()
  }

  const rows = [
    { label: 'Git changes', Icon: GitBranch, run: onOpenGitChanges },
    { label: 'Files', Icon: FolderTree, run: onOpenFiles },
    { label: 'Command palette', Icon: Search, run: onOpenCommandPalette },
    { label: 'New terminal', Icon: TerminalSquare, run: onNewTerminal },
    { label: 'Project settings', Icon: Settings, run: onOpenProjectSettings }
  ]
  const visibleRows = rows.flatMap(({ label, Icon, run }) => (run ? [{ label, Icon, run }] : []))

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
            className={`${ROW_CLASS_NAME} hover:bg-accent`}
            onClick={choose(run)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
        {onCloseChat && (
          <div
            className={visibleRows.length > 0 ? 'mt-1 border-t border-border/60 pt-1' : undefined}
          >
            <button
              type="button"
              className={`${ROW_CLASS_NAME} text-destructive hover:bg-destructive/10`}
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
