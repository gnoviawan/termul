import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ConnectionStatusIndicator } from '@/components/ConnectionStatusIndicator'
import { findVisibleQuestionFocusTarget } from '@/components/chat/use-approval-dock'
import {
  Camera,
  ChevronDown,
  FileCode,
  FolderGit2,
  FolderTree,
  History,
  MessageSquare,
  Plus,
  Search,
  Settings,
  TerminalSquare,
  type TermulIcon
} from '@/components/icons'
import { ProjectIcon } from '@/components/ProjectIcon'
import { TermulMark } from '@/components/TermulMark'
import { Button } from '@/components/ui/button'
import { CountBadge } from '@/components/ui/count-badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { useAgentChatUnreadTracker } from '@/hooks/use-agent-chat-unread-tracker'
import {
  describeIsolationDetail,
  useChatIsolationContext
} from '@/hooks/use-chat-isolation-context'
import type { MobileSection } from '@/hooks/use-mobile-section'
import { returnFocusAfterConfirm } from '@/lib/confirm-focus-return'
import {
  holdSheetReturnTargets,
  setSheetFocusDestination,
  sheetCloseAutoFocus
} from '@/lib/sheet-focus-return'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { getActiveWorktreeFromStore, useActiveProject } from '@/stores/project-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { MobileDrawerSectionList } from './MobileDrawerSectionList'
import { MobileRecentsList } from './MobileRecentsList'

/** Id of the shell header's `h1`: where a navigation hands focus. Without it the opener wins. */
const SHELL_TITLE_ID = 'mobile-shell-title'

/** Registry id: the overlay id the shell registers the drawer under, and its focus-return key. */
const DRAWER_FOCUS_ID = 'mobile-drawer'

/**
 * Focus return when the drawer closes (`lib/sheet-focus-return.ts`). The shell
 * records the control that opened it (☰ or the attention pill, with ☰ as the
 * fallback); a navigation close sets a destination instead.
 */
const drawerCloseAutoFocus = sheetCloseAutoFocus(DRAWER_FOCUS_ID)

/**
 * Where focus goes after a navigation close, resolved once the drawer has
 * closed: the open question's first option in the chat now on screen (the
 * destination chat only becomes visible in the commit that closes the drawer),
 * else the shell title. Never an editor or xterm, so the keyboard stays down.
 * A question control that refuses focus (a disabled or inert option) falls
 * through to the title, not on to the opener.
 */
const resolveNavigationFocus = (): HTMLElement | null => {
  const question = findVisibleQuestionFocusTarget()
  if (question) {
    question.focus()
    if (document.activeElement === question) return question
  }
  return document.getElementById(SHELL_TITLE_ID)
}

/** The drawer's section nav rows, Claude-app style, at the top of the drawer. */
const SECTION_NAV: ReadonlyArray<{ section: MobileSection; label: string; Icon: TermulIcon }> = [
  { section: 'chats', label: 'Chats', Icon: MessageSquare },
  { section: 'terminals', label: 'Terminals', Icon: TerminalSquare },
  { section: 'editors', label: 'Editors', Icon: FileCode }
]

/** The drawer's list heading for each section. */
const SECTION_HEADINGS: Record<MobileSection, string> = {
  chats: 'Recents',
  terminals: 'Terminals',
  editors: 'Editors'
}

interface MobileShellDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * The active tab's section: preselected each time the drawer opens (Chats:
   * Recents, Terminals, Editors). `null` (no tab, or a Git History tab)
   * preselects Chats. The nav rows switch the list from there.
   */
  section?: MobileSection | null
  /** Chats that need the user, excluding the one on screen: the Chats nav badge. */
  attentionCount?: number
  /** The active pane's active tab id (that row is `aria-current="page"`). */
  activeTabId: string | null
  /** The active chat's session id, or null outside a chat. */
  activeSessionId: string | null
  /** Whether a new chat can be started (active project has a path). */
  canNewChat: boolean
  onNewChat: () => void
  onNewTerminal?: () => void
  /** Returns `true` only when the close opened the confirm (the drawer then hands off to it). */
  onCloseTerminal?: (terminalId: string, tabId: string) => boolean
  onRenameTerminal?: (terminalId: string, name: string) => void
  /** Returns `true` only when the close opened the dirty-file confirm. */
  onCloseEditorTab?: (filePath: string) => boolean
  /** Opens a git history tab in the active pane (desktop entry mirrors this). */
  onOpenGitHistory?: () => void
  /** Opens the project sheet (web only). */
  onOpenProjects: () => void
  /** Opens the Files sheet: the Editors section's Browse files (web only). */
  onOpenFiles?: () => void
}

/**
 * The project row's two lines. The isolation detail comes from
 * `useChatIsolationContext` (the rules the composer and the header subtitle
 * use): in a chat the session's own project, worktree and branch win; outside a
 * chat the active project and its active worktree apply. A detached HEAD reads
 * "Detached HEAD", a worktree chat with no recorded branch reads "Worktree",
 * and a non-git project shows its name only.
 */
function DrawerProjectRow({
  activeSessionId,
  onOpen
}: {
  activeSessionId: string | null
  onOpen: () => void
}): React.JSX.Element {
  const activeProject = useActiveProject()
  const sessionProjectId = useAcpStore((s) =>
    activeSessionId ? s.sessions?.[activeSessionId]?.projectId : undefined
  )
  const sessionWorktreePath = useAcpStore((s) =>
    activeSessionId ? s.sessions?.[activeSessionId]?.worktreePath : undefined
  )
  const sessionWorktreeBranch = useAcpStore((s) =>
    activeSessionId ? s.sessions?.[activeSessionId]?.worktreeBranch : undefined
  )
  const chatSessionLoaded = Boolean(sessionProjectId)
  const activeWorktree =
    !chatSessionLoaded && activeProject ? getActiveWorktreeFromStore(activeProject.id) : undefined
  const isolation = useChatIsolationContext({
    projectId: chatSessionLoaded ? sessionProjectId : activeProject?.id,
    worktreePath: chatSessionLoaded ? sessionWorktreePath : activeWorktree?.path,
    worktreeBranch: chatSessionLoaded ? sessionWorktreeBranch : activeWorktree?.branch
  })
  const detail = activeProject ? describeIsolationDetail(isolation) : null

  return (
    <Button
      type="button"
      variant="ghost"
      className="h-auto min-h-11 w-full justify-start gap-2 px-3 py-1.5"
      aria-haspopup="dialog"
      onClick={onOpen}
    >
      {activeProject ? (
        <ProjectIcon project={activeProject} size={20} />
      ) : (
        <FolderGit2 size={20} aria-hidden="true" />
      )}
      <span className="flex min-w-0 flex-1 flex-col items-start text-left">
        <span className="max-w-full truncate text-sm font-medium">
          {activeProject?.name ?? 'No project'}
        </span>
        {detail && (
          <span className="max-w-full truncate text-xs font-normal text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
      <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-muted-foreground" />
    </Button>
  )
}

/**
 * The mobile shell's full-screen drawer, Claude-style: wordmark, section nav
 * (Chats with the attention badge, Terminals, Editors; a tap switches the list
 * without closing), project row, search, then one scrolling list for the chosen
 * section (Chats: Recents, open chats merged into history; Terminals; Editors;
 * the active tab's section is preselected on open) and a pinned footer
 * (Settings, Snapshots, Git history, connection status, and the section's
 * primary pill: New chat, New terminal or Browse files). It owns where focus
 * lands when it opens and closes; the shell owns the open state and records
 * the opener.
 */
export function MobileShellDrawer({
  open,
  onOpenChange,
  section = null,
  attentionCount = 0,
  activeTabId,
  activeSessionId,
  canNewChat,
  onNewChat,
  onNewTerminal,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  onOpenGitHistory,
  onOpenProjects,
  onOpenFiles
}: MobileShellDrawerProps): React.JSX.Element {
  const navigate = useNavigate()
  const activeProject = useActiveProject()
  const [query, setQuery] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // The pending focus return of a hand-off to a close confirm; cancelled when
  // the drawer unmounts first, or when a newer hand-off replaces it.
  const cancelFocusReturnRef = useRef<(() => void) | null>(null)
  const searchId = useId()
  const listHeadingId = useId()
  // The section the drawer lists: the active tab's on each open, then whatever
  // nav row the user picks. It never follows the active tab while open, so
  // closing a section's last row does not swap the list out from under them.
  // (Synced during render, React's "adjust state on a prop change" pattern, so
  // the first open frame already shows the right list.)
  const [listSection, setListSection] = useState<MobileSection>(section ?? 'chats')
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setListSection(section ?? 'chats')
  }

  // Mounted here (not in a row) because Recents rows are unmounted while the
  // drawer is closed, and a turn that finishes behind it must still bank
  // "New activity".
  useAgentChatUnreadTracker(activeSessionId)

  // The search is scoped to this open drawer: a new visit starts unfiltered.
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  useEffect(() => () => cancelFocusReturnRef.current?.(), [])

  // A row took the user somewhere: focus follows to the destination (resolved
  // at close time). A hand-off (another overlay opening) or a dismissal sets
  // nothing, so focus stays in the overlay that took it, else returns to the opener.
  const closeForNavigation = (): void => {
    setSheetFocusDestination(DRAWER_FOCUS_ID, resolveNavigationFocus)
    onOpenChange(false)
  }
  const closeForHandoff = (): void => onOpenChange(false)

  // A row close that raised a confirm (a terminal, a dirty file): the confirm
  // would render under this drawer's overlay, so the drawer gets out of its
  // way (a hand-off, like New chat). The confirm never takes or returns focus,
  // and the close consumes the recorded opener, so read it first and put focus
  // back on it once the confirm is gone.
  const onConfirmOpened = (): void => {
    const restoreFocus = holdSheetReturnTargets(DRAWER_FOCUS_ID)
    closeForHandoff()
    cancelFocusReturnRef.current?.()
    cancelFocusReturnRef.current = returnFocusAfterConfirm(restoreFocus)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={contentRef}
        side="left"
        id="mobile-shell-drawer"
        className="flex w-full max-w-none flex-col gap-0 border-r-0 p-0 pt-[env(safe-area-inset-top)] sm:max-w-none [&>button:last-child]:mt-[env(safe-area-inset-top)]"
        onEscapeKeyDown={(event) => {
          // Radix hears Escape on the document before the rename field does and
          // would dismiss the drawer. Inside a row's rename field the key only
          // cancels the rename (its own handler returns focus to the pencil).
          if (
            event.target instanceof Element &&
            event.target.closest('[data-section-rename-input]')
          ) {
            event.preventDefault()
          }
        }}
        onOpenAutoFocus={(event) => {
          // Land on the active row (or the title), never the search: the
          // on-screen keyboard must not rise just because the drawer opened.
          event.preventDefault()
          const current = contentRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
          ;(current ?? titleRef.current)?.focus()
        }}
        onCloseAutoFocus={drawerCloseAutoFocus}
      >
        {/* Top row: the project (web) beside the built-in close. The title stays
            the dialog's name; it is visible only where there is no project row. */}
        <SheetHeader className="space-y-0 px-2 pb-2 pt-2 text-left">
          <div className="flex min-h-11 items-center gap-2 pr-10">
            {isTauriContext() ? (
              <>
                <TermulMark size={20} className="ml-2 shrink-0" />
                <SheetTitle ref={titleRef} tabIndex={-1} className="text-base font-semibold">
                  Termul
                </SheetTitle>
              </>
            ) : (
              <>
                <SheetTitle ref={titleRef} tabIndex={-1} className="sr-only">
                  Termul
                </SheetTitle>
                <div className="min-w-0 flex-1">
                  <DrawerProjectRow
                    activeSessionId={activeSessionId}
                    onOpen={() => {
                      closeForHandoff()
                      onOpenProjects()
                    }}
                  />
                </div>
              </>
            )}
          </div>
          <SheetDescription className="sr-only">
            Browse and open chats, terminals and editors
          </SheetDescription>
        </SheetHeader>

        {/* Section tabs, one line: switch the list below without closing the drawer. */}
        <nav aria-label="Sections" className="shrink-0 px-2 pb-2">
          <div className="flex items-center gap-0.5 rounded-full bg-secondary p-1">
            {SECTION_NAV.map(({ section: item, label, Icon }) => {
              const isCurrent = listSection === item
              const badge = item === 'chats' && attentionCount > 0 ? attentionCount : 0
              return (
                <button
                  key={item}
                  type="button"
                  data-section-nav={item}
                  aria-current={isCurrent ? 'true' : undefined}
                  aria-label={
                    badge > 0 ? `${label}, ${badge} ${badge === 1 ? 'needs' : 'need'} you` : label
                  }
                  onClick={() => setListSection(item)}
                  className={cn(
                    'flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-sm outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    isCurrent
                      ? 'bg-background font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Icon size={16} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 truncate">{label}</span>
                  {badge > 0 && (
                    <CountBadge
                      count={badge}
                      max={9}
                      data-testid="drawer-attention-badge"
                      className="h-4 min-w-4 shrink-0 text-3xs"
                    />
                  )}
                </button>
              )
            })}
          </div>
        </nav>

        <div className="flex shrink-0 flex-col gap-2 px-2 pb-2">
          {listSection === 'chats' && (
            <div className="relative">
              <label htmlFor={searchId} className="sr-only">
                Search chats
              </label>
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                id={searchId}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats…"
                className="min-h-11 w-full rounded-full bg-secondary py-1 pl-8 pr-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </div>
          )}
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <h2
            id={listHeadingId}
            tabIndex={-1}
            className="px-4 pb-1 pt-2 text-sm font-medium text-muted-foreground outline-none"
          >
            {SECTION_HEADINGS[listSection]}
          </h2>
          {listSection === 'chats' ? (
            <MobileRecentsList
              query={query}
              headingId={listHeadingId}
              scrollRootRef={scrollRef}
              activeTabId={activeTabId}
              onNavigate={closeForNavigation}
            />
          ) : (
            <MobileDrawerSectionList
              section={listSection}
              headingId={listHeadingId}
              activeTabId={activeTabId}
              onNavigate={closeForNavigation}
              onCloseTerminal={onCloseTerminal}
              onRenameTerminal={onRenameTerminal}
              onCloseEditorTab={onCloseEditorTab}
              onConfirmOpened={onConfirmOpened}
            />
          )}
        </div>

        <div className="shrink-0 border-t border-border/60 px-2 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className="flex min-w-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              aria-label="Settings"
              onClick={() => {
                closeForHandoff()
                useSettingsModalStore.getState().openApp()
              }}
            >
              <Settings size={16} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              aria-label="Snapshots"
              onClick={() => {
                closeForNavigation()
                navigate('/snapshots')
              }}
            >
              <Camera size={16} />
            </Button>
            {!isTauriContext() && onOpenGitHistory && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                aria-label="Git history"
                disabled={!activeProject?.path}
                onClick={() => {
                  closeForNavigation()
                  onOpenGitHistory()
                }}
              >
                <History size={16} />
              </Button>
            )}
            <div className="ml-auto flex min-w-0 shrink items-center">
              {listSection === 'chats' && (
                <Button
                  type="button"
                  size="touch"
                  className="min-w-0 rounded-full px-4"
                  disabled={!canNewChat}
                  onClick={() => {
                    closeForHandoff()
                    onNewChat()
                  }}
                >
                  <Plus size={16} />
                  New chat
                </Button>
              )}
              {listSection === 'terminals' && (
                <Button
                  type="button"
                  size="touch"
                  className="min-w-0 rounded-full px-4"
                  disabled={!onNewTerminal}
                  onClick={() => {
                    closeForNavigation()
                    onNewTerminal?.()
                  }}
                >
                  <Plus size={16} />
                  New terminal
                </Button>
              )}
              {listSection === 'editors' && (
                <Button
                  type="button"
                  size="touch"
                  className="min-w-0 rounded-full px-4"
                  disabled={!onOpenFiles}
                  onClick={() => {
                    closeForHandoff()
                    onOpenFiles?.()
                  }}
                >
                  <FolderTree size={16} />
                  Browse files
                </Button>
              )}
            </div>
          </div>
          <div className="px-3 pb-1">
            <ConnectionStatusIndicator showLabel />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
