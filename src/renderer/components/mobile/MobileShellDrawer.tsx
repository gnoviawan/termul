import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ConnectionStatusIndicator } from '@/components/ConnectionStatusIndicator'
import { ChatHistoryTab } from '@/components/chat/ChatHistoryTab'
import { findVisibleQuestionFocusTarget } from '@/components/chat/use-approval-dock'
import {
  Camera,
  ChevronDown,
  FolderGit2,
  History,
  MessageSquarePlus,
  Search,
  Settings
} from '@/components/icons'
import { ProjectIcon } from '@/components/ProjectIcon'
import { TermulMark } from '@/components/TermulMark'
import { Button } from '@/components/ui/button'
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
import { setSheetFocusDestination, sheetCloseAutoFocus } from '@/lib/sheet-focus-return'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { getActiveWorktreeFromStore, useActiveProject } from '@/stores/project-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { MobileDrawerOpenSection } from './MobileDrawerOpenSection'

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

interface MobileShellDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The active pane's active tab id (that Open row is `aria-current="page"`). */
  activeTabId: string | null
  /** The active chat's session id, or null outside a chat. */
  activeSessionId: string | null
  /** Whether a new chat can be started (active project has a path). */
  canNewChat: boolean
  onNewChat: () => void
  onNewTerminal?: () => void
  onCloseTerminal?: (terminalId: string, tabId: string) => void
  onRenameTerminal?: (terminalId: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  /** Opens a git history tab in the active pane (desktop entry mirrors this). */
  onOpenGitHistory?: () => void
  /** Opens the project sheet (web only). */
  onOpenProjects: () => void
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
 * The mobile shell's left drawer, laid out as the app's home: project row,
 * search, New chat, then a scrolling body (Open: chats with live status,
 * Terminals, Tabs; History) and a pinned footer (Settings, Snapshots, Git
 * history, connection status). It owns where focus lands when it opens and
 * closes; the shell owns the open state and records the opener.
 */
export function MobileShellDrawer({
  open,
  onOpenChange,
  activeTabId,
  activeSessionId,
  canNewChat,
  onNewChat,
  onNewTerminal,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  onOpenGitHistory,
  onOpenProjects
}: MobileShellDrawerProps): React.JSX.Element {
  const navigate = useNavigate()
  const activeProject = useActiveProject()
  const [query, setQuery] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchId = useId()
  const openHeadingId = useId()
  const historyHeadingId = useId()

  // Mounted here (not in a row) because Open rows are unmounted while the
  // drawer is closed, and a turn that finishes behind it must still bank
  // "New activity".
  useAgentChatUnreadTracker(activeSessionId)

  // The search is scoped to this open drawer: a new visit starts unfiltered.
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  // A row took the user somewhere: focus follows to the destination (resolved
  // at close time). A hand-off (another overlay opening) or a dismissal sets
  // nothing, so focus stays in the overlay that took it, else returns to the opener.
  const closeForNavigation = (): void => {
    setSheetFocusDestination(DRAWER_FOCUS_ID, resolveNavigationFocus)
    onOpenChange(false)
  }
  const closeForHandoff = (): void => onOpenChange(false)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={contentRef}
        side="left"
        id="mobile-shell-drawer"
        className="flex w-[min(82vw,20rem)] flex-col gap-0 p-0"
        onOpenAutoFocus={(event) => {
          // Land on the active Open row (or the title), never the search: the
          // on-screen keyboard must not rise just because the drawer opened.
          event.preventDefault()
          const current = contentRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
          ;(current ?? titleRef.current)?.focus()
        }}
        onCloseAutoFocus={drawerCloseAutoFocus}
      >
        <SheetHeader className="space-y-0 border-b border-border/60 p-2 text-left">
          <div className="flex items-center gap-2 pr-8">
            <TermulMark size={20} />
            <SheetTitle ref={titleRef} tabIndex={-1} className="text-base">
              Menu
            </SheetTitle>
          </div>
          <SheetDescription className="sr-only">
            Browse and open agent chat sessions
          </SheetDescription>
        </SheetHeader>

        <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 p-2">
          {!isTauriContext() && (
            <DrawerProjectRow
              activeSessionId={activeSessionId}
              onOpen={() => {
                closeForHandoff()
                onOpenProjects()
              }}
            />
          )}

          <div className="relative">
            <label htmlFor={searchId} className="sr-only">
              Search chats
            </label>
            <Search
              size={12}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              id={searchId}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats…"
              className="min-h-11 w-full rounded-md bg-background py-1 pl-7 pr-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>

          <Button
            type="button"
            variant="secondary"
            className="min-h-11 w-full justify-start gap-2"
            disabled={!canNewChat}
            onClick={() => {
              closeForHandoff()
              onNewChat()
            }}
          >
            <MessageSquarePlus size={16} />
            New chat
          </Button>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <h2 id={openHeadingId} className="label-group px-3 pb-1 pt-3 text-muted-foreground">
            Open
          </h2>
          <MobileDrawerOpenSection
            activeTabId={activeTabId}
            openHeadingId={openHeadingId}
            onNavigate={closeForNavigation}
            onNewTerminal={onNewTerminal}
            onCloseTerminal={onCloseTerminal}
            onRenameTerminal={onRenameTerminal}
            onCloseEditorTab={onCloseEditorTab}
          />

          <h2
            id={historyHeadingId}
            tabIndex={-1}
            className="label-group border-t border-border/60 px-3 pb-1 pt-3 text-muted-foreground"
          >
            History
          </h2>
          <ChatHistoryTab
            onSessionOpened={closeForNavigation}
            query={query}
            historyHeadingId={historyHeadingId}
            scrollRootRef={scrollRef}
          />
        </div>

        <div className="shrink-0 border-t border-border/60 px-2 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center gap-1">
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
          </div>
          <div className="px-3 pb-1">
            <ConnectionStatusIndicator showLabel />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
