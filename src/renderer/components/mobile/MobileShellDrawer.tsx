import { type RefObject, useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ConnectionStatusIndicator } from '@/components/ConnectionStatusIndicator'
import { ChatHistoryTab } from '@/components/chat/ChatHistoryTab'
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
import { returnFocusAfterConfirm } from '@/lib/confirm-focus-return'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import {
  getActiveWorktreeFromStore,
  useActiveProject,
  useProjectStore
} from '@/stores/project-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { MobileDrawerOpenSection } from './MobileDrawerOpenSection'

/**
 * How the drawer closed, which decides where focus goes:
 *  - `dismiss`: Esc, scrim, the built-in close or back: return to the opener.
 *  - `navigate`: a row took the user somewhere: the destination title, else the opener.
 *  - `handoff`: another overlay is opening: leave focus there, else the opener.
 */
type CloseIntent = 'dismiss' | 'navigate' | 'handoff'

/** Id of the shell header's `h1`: where a navigation hands focus. Without it the opener wins. */
const SHELL_TITLE_ID = 'mobile-shell-title'

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
  /** Returns `true` only when the close opened the confirm (the drawer then hands off to it). */
  onCloseTerminal?: (terminalId: string, tabId: string) => boolean
  onRenameTerminal?: (terminalId: string, name: string) => void
  /** Returns `true` only when the close opened the dirty-file confirm. */
  onCloseEditorTab?: (filePath: string) => boolean
  /** Opens a git history tab in the active pane (desktop entry mirrors this). */
  onOpenGitHistory?: () => void
  /** Opens the project sheet (web only). */
  onOpenProjects: () => void
  /** The element that opened the drawer; focus returns here on dismiss. */
  returnFocusRef: RefObject<HTMLElement | null>
  /** The shell's ☰ button: the fallback when the recorded opener is gone. */
  menuButtonRef: RefObject<HTMLElement | null>
}

/**
 * The project row's two lines. Re-applies the `ChatInputBar` rules locally:
 * in a chat the session's own worktree/branch win over its project's
 * `gitBranch`; outside a chat the active worktree and project apply. A
 * detached HEAD (git project, no branch, no worktree) reads "Detached HEAD";
 * a non-git project shows its name only.
 */
function DrawerProjectRow({
  activeSessionId,
  onOpen
}: {
  activeSessionId: string | null
  onOpen: () => void
}): React.JSX.Element {
  const activeProject = useActiveProject()
  const session = useAcpStore((s) => (activeSessionId ? s.sessions?.[activeSessionId] : undefined))
  const sessionProject = useProjectStore((s) =>
    session ? s.projects.find((p) => p.id === session.projectId) : undefined
  )

  let isWorktree = false
  let branch: string | null = null
  let isGitRepo = false
  if (session) {
    const project = sessionProject ?? activeProject
    isWorktree = Boolean(session.worktreePath)
    branch = session.worktreeBranch ?? project?.gitBranch ?? null
    isGitRepo = project?.isGitRepo ?? false
  } else if (activeProject) {
    const worktree = getActiveWorktreeFromStore(activeProject.id)
    isWorktree = Boolean(worktree)
    branch = worktree?.branch ?? activeProject.gitBranch ?? null
    isGitRepo = activeProject.isGitRepo ?? false
  }
  const isDetachedHead = !branch && !isWorktree && isGitRepo
  const detail =
    activeProject && (branch || isDetachedHead)
      ? `${branch ?? 'Detached HEAD'} · ${isWorktree ? 'Worktree' : 'Local'}`
      : null

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
 * closes; the shell owns the open state and the opener bookkeeping.
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
  onOpenProjects,
  returnFocusRef,
  menuButtonRef
}: MobileShellDrawerProps): React.JSX.Element {
  const navigate = useNavigate()
  const activeProject = useActiveProject()
  const [query, setQuery] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const closeIntentRef = useRef<CloseIntent>('dismiss')
  // The pending focus return of a hand-off to a close confirm; cancelled when
  // the drawer unmounts first, or when a newer hand-off replaces it.
  const cancelFocusReturnRef = useRef<(() => void) | null>(null)
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

  useEffect(() => () => cancelFocusReturnRef.current?.(), [])

  const closeWith = (intent: CloseIntent): void => {
    closeIntentRef.current = intent
    onOpenChange(false)
  }
  const closeForNavigation = (): void => closeWith('navigate')

  /** Focus the recorded opener, else ☰. True when focus landed on it. */
  const focusOpener = (): boolean => {
    const opener = returnFocusRef.current
    const target = opener?.isConnected ? opener : menuButtonRef.current
    target?.focus()
    return Boolean(target) && document.activeElement === target
  }

  // A row close that raised a confirm (a terminal, a dirty file): the confirm
  // would render under this drawer's overlay, so the drawer gets out of its
  // way (a hand-off, like New chat). The confirm never takes or returns focus,
  // so once it is gone focus goes back to the opener.
  const onConfirmOpened = (): void => {
    closeWith('handoff')
    cancelFocusReturnRef.current?.()
    cancelFocusReturnRef.current = returnFocusAfterConfirm(focusOpener)
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // Radix-initiated closes (Esc, scrim, the built-in close) are dismissals.
        if (!next) closeIntentRef.current = 'dismiss'
        onOpenChange(next)
      }}
    >
      <SheetContent
        ref={contentRef}
        side="left"
        id="mobile-shell-drawer"
        className="flex w-[min(82vw,20rem)] flex-col gap-0 p-0"
        onOpenAutoFocus={(event) => {
          // Land on the active Open row (or the title), never the search: the
          // on-screen keyboard must not rise just because the drawer opened.
          event.preventDefault()
          closeIntentRef.current = 'dismiss'
          const current = contentRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
          ;(current ?? titleRef.current)?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const intent = closeIntentRef.current
          closeIntentRef.current = 'dismiss'
          // Another overlay already holds focus (a hand-off to the launcher,
          // Settings or the project sheet): focusing ☰ behind it would steal it.
          const otherDialog = document.activeElement?.closest(
            '[role="dialog"], [role="alertdialog"]'
          )
          if (otherDialog && otherDialog !== contentRef.current) return
          if (intent === 'navigate') {
            const title = document.getElementById(SHELL_TITLE_ID)
            title?.focus()
            if (title && document.activeElement === title) return
          }
          focusOpener()
        }}
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
                closeWith('handoff')
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
              closeWith('handoff')
              onNewChat()
            }}
          >
            <MessageSquarePlus size={16} />
            New chat
          </Button>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <h2
            id={openHeadingId}
            tabIndex={-1}
            className="label-group px-3 pb-1 pt-3 text-muted-foreground"
          >
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
            onConfirmOpened={onConfirmOpened}
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
                closeWith('handoff')
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
