import { type RefObject, useEffect, useState } from 'react'
import { ChevronDown, Menu, MessageSquarePlus, MoreHorizontal } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { subscribeMediaQuery } from '@/hooks/use-mobile-web-shell'
import { isTauriContext } from '@/lib/tauri-runtime'
import { MOBILE_HEADER_MORE_SHEET_ID } from './MobileHeaderMoreSheet'
import { MOBILE_TERMINAL_ACTIONS_SHEET_ID } from './MobileTerminalActionsSheet'

/**
 * Header icon hit box: 44px (`size-11`) on every slot. `size="icon"` is 40px;
 * this class wins via tailwind-merge.
 */
const HEADER_ICON_BUTTON = 'size-11 shrink-0'

/**
 * Target of the ☰ and pill `aria-controls`: the id of the shell drawer's
 * `SheetContent`. `aria-controls` is emitted only while the drawer is open.
 */
const DRAWER_ID = 'mobile-shell-drawer'
const PROJECT_SHEET_ID = 'mobile-project-sheet'

/** Narrow phones fold the attention pill into a dot on the menu button. */
const NARROW_QUERY = '(max-width: 360px)'

function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(NARROW_QUERY)
    setNarrow(mql.matches)
    return subscribeMediaQuery(mql, setNarrow)
  }, [])
  return narrow
}

function chatsNeedYou(count: number): string {
  return count === 1 ? '1 chat needs you' : `${count} chats need you`
}

interface MobileShellHeaderProps {
  /** Chat, terminal or tab name; rendered as the `h1`. */
  title: string
  /** Visible subtitle: project · branch · Local or Worktree. */
  subtitleText: string
  /** Accessible name of the subtitle button. */
  subtitleLabel: string
  drawerOpen: boolean
  /**
   * Opens the drawer. The control that was activated (☰ or the pill) is passed
   * so the drawer can return focus to it on dismiss.
   */
  onOpenDrawer: (opener: HTMLElement) => void
  /** The ☰ button: the drawer's focus fallback when the pill is gone. */
  menuButtonRef?: RefObject<HTMLButtonElement>
  projectSheetOpen: boolean
  onOpenProjectSheet: () => void
  /** Other chats in the active project that need the user; the pill hides at 0. */
  attentionCount: number
  /** A terminal tab is active: ✎ starts a terminal and ⋯ opens terminal actions. */
  isTerminal: boolean
  canNewChat: boolean
  onNewChat: () => void
  onNewTerminal?: () => void
  /** Whether the ⋯ sheet for this context (header or terminal) is open. */
  moreOpen: boolean
  onOpenMore: () => void
  moreButtonRef: RefObject<HTMLButtonElement>
  subtitleRef: RefObject<HTMLButtonElement>
  titleRef: RefObject<HTMLHeadingElement>
}

/**
 * Mobile shell header: ☰ · title block · attention pill · ✎ · ⋯. Three 44px
 * icon slots plus the title block, and nothing scrolls sideways. The title is a
 * plain heading; the subtitle under it opens the project sheet.
 */
export function MobileShellHeader({
  title,
  subtitleText,
  subtitleLabel,
  drawerOpen,
  onOpenDrawer,
  menuButtonRef,
  projectSheetOpen,
  onOpenProjectSheet,
  attentionCount,
  isTerminal,
  canNewChat,
  onNewChat,
  onNewTerminal,
  moreOpen,
  onOpenMore,
  moreButtonRef,
  subtitleRef,
  titleRef
}: MobileShellHeaderProps): React.JSX.Element {
  const narrow = useNarrowViewport()
  const hasAttention = attentionCount > 0
  const foldedIntoMenu = narrow && hasAttention
  const showPill = hasAttention && !narrow
  const pillLabel =
    attentionCount === 1 ? '1 other chat needs you' : `${attentionCount} other chats need you`
  const showNewTerminal = isTerminal && Boolean(onNewTerminal)
  const showNewChat = !isTerminal && canNewChat
  const moreSheetId = isTerminal ? MOBILE_TERMINAL_ACTIONS_SHEET_ID : MOBILE_HEADER_MORE_SHEET_ID

  return (
    <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      <Button
        ref={menuButtonRef}
        type="button"
        variant="ghost"
        size="icon"
        className={`${HEADER_ICON_BUTTON} relative`}
        aria-label={foldedIntoMenu ? `Open menu, ${chatsNeedYou(attentionCount)}` : 'Open menu'}
        aria-expanded={drawerOpen}
        aria-controls={drawerOpen ? DRAWER_ID : undefined}
        onClick={(event) => onOpenDrawer(event.currentTarget)}
      >
        <Menu size={20} />
        {foldedIntoMenu && (
          <span
            aria-hidden="true"
            className="absolute right-2 top-2 size-2 rounded-full bg-warning"
          />
        )}
      </Button>

      <div
        className="relative flex min-w-0 flex-1 flex-col items-center justify-center self-stretch"
        data-mobile-header-title=""
      >
        <h1
          ref={titleRef}
          id="mobile-shell-title"
          tabIndex={-1}
          className="pointer-events-none max-w-full truncate text-sm font-medium text-foreground focus:outline-none"
        >
          {title}
        </h1>
        {isTauriContext() ? (
          <span className="max-w-full truncate px-1 text-xs text-muted-foreground">
            {subtitleText}
          </span>
        ) : (
          <Button
            ref={subtitleRef}
            type="button"
            variant="ghost"
            className="h-auto max-w-full min-w-0 gap-1 px-1 py-0 text-xs font-normal text-muted-foreground after:absolute after:inset-0 after:content-[''] [&_svg]:size-3"
            aria-label={subtitleLabel}
            aria-haspopup="dialog"
            aria-expanded={projectSheetOpen}
            aria-controls={projectSheetOpen ? PROJECT_SHEET_ID : undefined}
            onClick={onOpenProjectSheet}
          >
            <span className="min-w-0 truncate">{subtitleText}</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        )}
      </div>

      {showPill && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="relative mx-1 h-auto min-h-7 rounded-full bg-warning/20 px-2 text-xs font-semibold tabular-nums text-warning hover:bg-warning/30 hover:text-warning after:absolute after:-inset-2 after:content-['']"
          aria-label={pillLabel}
          aria-expanded={drawerOpen}
          aria-controls={drawerOpen ? DRAWER_ID : undefined}
          onClick={(event) => onOpenDrawer(event.currentTarget)}
        >
          <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
          {attentionCount > 9 ? '9+' : attentionCount}
        </Button>
      )}

      {(showNewTerminal || showNewChat) && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={HEADER_ICON_BUTTON}
          aria-label={isTerminal ? 'New terminal' : 'New chat'}
          onClick={isTerminal ? onNewTerminal : onNewChat}
        >
          <MessageSquarePlus size={20} />
        </Button>
      )}

      <Button
        ref={moreButtonRef}
        type="button"
        variant="ghost"
        size="icon"
        className={HEADER_ICON_BUTTON}
        aria-label={isTerminal ? 'Terminal actions' : 'More'}
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        aria-controls={moreOpen ? moreSheetId : undefined}
        onClick={onOpenMore}
      >
        <MoreHorizontal size={20} />
      </Button>
    </header>
  )
}
