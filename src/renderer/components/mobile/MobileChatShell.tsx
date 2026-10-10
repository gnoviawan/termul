import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ProjectSwitcherDrawer } from '@/components/chat/ProjectSwitcherDrawer'
import { requestCloseAgentChat } from '@/hooks/use-agent-idle-shutdown'
import {
  describeProjectSubtitle,
  useChatIsolationContext
} from '@/hooks/use-chat-isolation-context'
import { useMobileAttentionCount } from '@/hooks/use-mobile-attention-count'
import { sectionForTab } from '@/hooks/use-mobile-section'
import { useMobileTabActions } from '@/hooks/use-mobile-tab-actions'
import { useShellAnnouncements } from '@/hooks/use-shell-announcements'
import { returnFocusAfterConfirm } from '@/lib/confirm-focus-return'
import {
  holdSheetReturnTargets,
  recordSheetOpener,
  setSheetFocusDestination,
  sheetCloseAutoFocus
} from '@/lib/sheet-focus-return'
import { isTauriContext } from '@/lib/tauri-runtime'
import { returnToWorkspaceRoute } from '@/lib/workspace-route'
import { useAcpStore } from '@/stores/acp-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { useActiveProject, useProjectStore } from '@/stores/project-store'
import { useShellAnnouncerStore } from '@/stores/shell-announcer-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import { MobileFileExplorer } from './MobileFileExplorer'
import { MobileHeaderMoreSheet } from './MobileHeaderMoreSheet'
import { MobileShellDrawer } from './MobileShellDrawer'
import { MobileShellHeader } from './MobileShellHeader'
import { MobileTerminalActionsSheet } from './MobileTerminalActionsSheet'
import { MobileTerminalControls } from './MobileTerminalControls'

const fileBasename = (path: string): string => path.split(/[\\/]/).pop() || path

/** A browser tab's name: its title, else its host, else "Browser" (as `WorkspaceTabBar`). */
function browserTabLabel(tab: { title: string; url: string } | undefined): string {
  if (tab?.title.trim()) return tab.title.trim()
  if (tab?.url) {
    try {
      const parsed = new URL(tab.url)
      return parsed.host || parsed.hostname || tab.url
    } catch {
      return tab.url.replace(/^https?:\/\//, '').split('/')[0] || 'Browser'
    }
  }
  return 'Browser'
}

// Focus return for the shell's sheets (`lib/sheet-focus-return.ts`), keyed by the
// overlay id each is registered under. Radix refocuses only a `Dialog.Trigger`,
// and these openers are plain Buttons. Built once at module scope so the
// handlers keep a stable identity across renders.
const projectSheetCloseAutoFocus = sheetCloseAutoFocus('projects-sheet')
const moreSheetCloseAutoFocus = sheetCloseAutoFocus('header-more-sheet')
const terminalSheetCloseAutoFocus = sheetCloseAutoFocus('terminal-actions-sheet')

interface MobileChatShellProps {
  children: React.ReactNode
  /** Opens the New Agent Chat launcher. */
  onNewChat: () => void
  /** Whether a new chat can be started (active project has a path). */
  canNewChat?: boolean
  /** Opens the command palette overlay (mounted in WorkspaceLayout appModals). */
  onOpenCommandPalette?: () => void
  /** Opens the Git Changes sheet (mounted in WorkspaceLayout mobile branch). */
  onOpenGitChanges?: () => void
  /** Opens a git history tab in the active pane (desktop entry mirrors this). */
  onOpenGitHistory?: () => void
  onNewTerminal?: () => void
  /**
   * Close a terminal tab. Returns `true` only when it opened the close confirm
   * (so the drawer hands off to it); closing at once, or refusing, returns
   * `false`.
   */
  onCloseTerminal?: (terminalId: string, tabId: string) => boolean
  onRenameTerminal?: (terminalId: string, name: string) => void
  onRestartTerminal?: (terminalId: string) => void
  /** Opens Project settings (header ⋯ sheet). */
  onOpenProjectSettings?: () => void
  /** Opens the command history modal (terminal ⋯ sheet). */
  onOpenCommandHistory?: () => void
  /**
   * Opens the New Project modal (Story 7, QA "no mobile creation entry"):
   * offered as the project sheet's "Add project" row, pinned below the project
   * list, so a second project can be created once at least one exists. The
   * drawer has no New project button of its own.
   */
  onNewProject?: () => void
  /**
   * Close an editor tab through the dirty-file guard (WorkspaceLayout
   * `handleCloseEditorTab` semantics) so drawer closes never silently
   * discard unsaved changes. Returns `true` only when it opened the dirty-file
   * confirm.
   */
  onCloseEditorTab?: (filePath: string) => boolean
}

/**
 * Claude-style mobile web chrome: a slim header over the content, and a
 * full-screen drawer that switches between Chats, Terminals and Editors and
 * lists the chosen section (the hidden WorkspaceTabBar's job on mobile). No
 * bottom bar: the main screen is the header and the content.
 * Desktop IDE chrome (ActivityRail, TitleBar, persistent sidebar, tab strip)
 * stays outside this component and must be gated by `useMobileWebShell`.
 */
export function MobileChatShell({
  children,
  onNewChat,
  canNewChat = false,
  onOpenCommandPalette,
  onOpenGitChanges,
  onRestartTerminal,
  onOpenProjectSettings,
  onOpenCommandHistory,
  onNewProject,
  onOpenGitHistory,
  onNewTerminal,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab
}: MobileChatShellProps): React.JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [terminalActionsOpen, setTerminalActionsOpen] = useState(false)
  const activeProject = useActiveProject()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const subtitleRef = useRef<HTMLButtonElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  // The drawer returns focus to whatever opened it. ☰ and the attention pill
  // both record themselves through `openDrawer`; ☰ is also the fallback when the
  // recorded opener is gone (the pill disappears once nothing needs the user).
  const openDrawer = (opener: HTMLElement | null): void => {
    recordSheetOpener('mobile-drawer', opener ?? menuButtonRef.current, menuButtonRef.current)
    setDrawerOpen(true)
  }
  // The project sheet opens from the header subtitle and from the drawer's
  // project row; focus returns to the subtitle either way.
  const openProjectSheet = (): void => {
    recordSheetOpener('projects-sheet', subtitleRef.current)
    setProjectsOpen(true)
  }

  // One persistent, visually hidden live region for the whole shell (rendered
  // below as a direct child of the root). The hook registers it and feeds it
  // from store transitions; sheets and menus never own announcements.
  useShellAnnouncements()
  const announcement = useShellAnnouncerStore((s) => s.message)

  // The drawer is the mobile tab chooser. Register the shell's sheets in the
  // overlay stack so hardware back (popstate) closes the topmost one instead
  // of exiting the app.
  useOverlayRegistration('mobile-drawer', drawerOpen, () => setDrawerOpen(false))
  useOverlayRegistration('projects-sheet', projectsOpen, () => setProjectsOpen(false))
  useOverlayRegistration('files-sheet', filesOpen, () => setFilesOpen(false))
  useOverlayRegistration('header-more-sheet', moreOpen, () => setMoreOpen(false))

  // Active tab — return the stable Tab object reference held in the store
  // tree. Stable references compare with Object.is, so no `useShallow` is
  // needed. Returning a new object/array literal here would make every
  // getSnapshot() differ and trigger an infinite re-render loop
  // (React error #185 / Maximum update depth exceeded).
  const activeTab = useWorkspaceStore((s) => {
    const leaves = getAllLeafPanes(s.root)
    const pane = leaves.find((p) => p.id === s.activePaneId) ?? leaves[0]
    return pane?.tabs.find((t) => t.id === pane.activeTabId) ?? null
  })

  // Active terminal — subscribe to the terminal store directly (not via
  // getState() inside the workspace selector) so updates are observed and the
  // returned reference stays stable across unrelated workspace changes.
  const activeTerminalId = activeTab?.type === 'terminal' ? activeTab.terminalId : undefined
  const activeTerminal = useTerminalStore((s) =>
    activeTerminalId ? s.terminals.find((terminal) => terminal.id === activeTerminalId) : undefined
  )

  const activeSessionId = activeTab?.type === 'agent-chat' ? activeTab.sessionId : null

  // Header ⋯ Close tab shares the drawer lists' guarded close routing.
  const { closePaneTab } = useMobileTabActions({
    onCloseTerminal,
    onCloseEditorTab
  })
  // The drawer opens on the active tab's section (Chats when none applies).
  const drawerSection = sectionForTab(activeTab)

  // Chat title: live session title, then the index entry, then "Agent Chat".
  // One narrow selector so streaming updates to other session fields do not
  // re-render the shell.
  const sessionTitle = useAcpStore((s) => {
    if (!activeSessionId) return null
    const live = s.sessions[activeSessionId]?.title
    if (live) return live
    return s.sessionIndex.find((e) => e.id === activeSessionId)?.title ?? null
  })
  const activeBrowserTab = useBrowserSessionStore((s) =>
    activeTab?.type === 'browser' ? s.tabs.get(activeTab.browserTabId) : undefined
  )

  // An empty terminal name falls back like a missing one (the old header
  // tested truthiness), so the title and the terminal sheet are never blank.
  const terminalName = activeTerminal?.name || 'Terminal'

  // Header title: the tab on screen's own name; an empty section's name; else
  // "Termul" when no tab is open.
  const headerTitle = ((): string => {
    if (!activeTab) return 'Termul'
    switch (activeTab.type) {
      case 'terminal':
        return terminalName
      case 'agent-chat':
        return sessionTitle ?? 'Agent Chat'
      case 'editor':
        return fileBasename(activeTab.filePath)
      case 'git':
        return 'Git Changes'
      case 'git-history':
        return 'Git History'
      case 'browser':
        return browserTabLabel(activeBrowserTab)
      case 'canvas':
        return fileBasename(activeTab.docPath)
    }
  })()

  // Header subtitle: a chat shows its own worktree and branch; any other
  // context (terminal, editor, git, browser, no tab) or a session that is not
  // loaded yet shows the active project's values.
  const sessionProjectId = useAcpStore((s) =>
    activeSessionId ? s.sessions[activeSessionId]?.projectId : undefined
  )
  const sessionWorktreePath = useAcpStore((s) =>
    activeSessionId ? s.sessions[activeSessionId]?.worktreePath : undefined
  )
  const sessionWorktreeBranch = useAcpStore((s) =>
    activeSessionId ? s.sessions[activeSessionId]?.worktreeBranch : undefined
  )
  // The name, branch and worktree all come from the same project: a chat whose
  // session belongs to another project than the active one (a project switch in
  // flight) must not pair the active project's name with that chat's branch.
  const sessionProjectName = useProjectStore((s) =>
    sessionProjectId ? s.projects.find((p) => p.id === sessionProjectId)?.name : undefined
  )
  const chatSessionLoaded = Boolean(sessionProjectId)
  const isolation = useChatIsolationContext({
    projectId: chatSessionLoaded ? sessionProjectId : activeProject?.id,
    worktreePath: chatSessionLoaded ? sessionWorktreePath : undefined,
    worktreeBranch: chatSessionLoaded ? sessionWorktreeBranch : undefined
  })
  const subtitle = describeProjectSubtitle(
    chatSessionLoaded ? (sessionProjectName ?? activeProject?.name) : activeProject?.name,
    isolation
  )
  const attentionCount = useMobileAttentionCount(activeProject?.id, activeSessionId)

  // The terminal ⋯ sheet and the key bar exist only for an active terminal tab.
  const isTerminalTab = activeTab?.type === 'terminal'
  const showTerminalControls = isTerminalTab && Boolean(activeTerminal?.ptyId)
  const terminalSheetOpen = terminalActionsOpen && isTerminalTab
  useOverlayRegistration('terminal-actions-sheet', terminalSheetOpen, () =>
    setTerminalActionsOpen(false)
  )
  // Both ⋯ sheets belong to the tab they opened on. A tab change underneath
  // them (another client, an agent opening a tab) closes them, so a stale sheet
  // cannot act on the wrong chat or terminal, nor reopen on the next one.
  const activeTabId = activeTab?.id
  const lastActiveTabIdRef = useRef(activeTabId)
  useEffect(() => {
    if (lastActiveTabIdRef.current === activeTabId) return
    lastActiveTabIdRef.current = activeTabId
    setMoreOpen(false)
    setTerminalActionsOpen(false)
  }, [activeTabId])

  // This shell's entry points that create or activate a tab (drawer, header ✎,
  // both ⋯ sheets, the Files sheet) leave /snapshots (or any other non-workspace
  // route) for the workspace, so the new tab is actually visible. Wrapped here,
  // once, so they agree; a missing handler stays missing so the controls keep
  // their gating.
  const returnToWorkspace = (): void => {
    returnToWorkspaceRoute(pathname, navigate)
  }
  const newTerminal = onNewTerminal
    ? (): void => {
        onNewTerminal()
        returnToWorkspace()
      }
    : undefined
  const openGitHistory = onOpenGitHistory
    ? (): void => {
        onOpenGitHistory()
        returnToWorkspace()
      }
    : undefined

  // Browse files (the drawer's Editors pill) opens the Files sheet; focus
  // returns to ☰, else the shell title.
  const openFilesFrom = !isTauriContext()
    ? (opener: HTMLElement | null): void => {
        recordSheetOpener('files-sheet', opener ?? titleRef.current, titleRef.current)
        setFilesOpen(true)
      }
    : undefined

  // Header ⋯ "Close tab" for a non-chat, non-terminal tab (Git History has no
  // other close on mobile): the same guarded close the drawer rows use. When
  // the close raised a confirm (a dirty editor) the sheet hands off to it, as
  // the drawer does: no focus return now, the opener once the confirm is gone.
  const skipMoreSheetFocusRef = useRef(false)
  const cancelConfirmFocusRef = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelConfirmFocusRef.current?.(), [])
  const closeActiveOtherTab =
    activeTab && activeTab.type !== 'agent-chat' && activeTab.type !== 'terminal'
      ? (): void => {
          if (!closePaneTab(activeTab)) return
          const restoreFocus = holdSheetReturnTargets('header-more-sheet')
          skipMoreSheetFocusRef.current = true
          cancelConfirmFocusRef.current?.()
          cancelConfirmFocusRef.current = returnFocusAfterConfirm(restoreFocus)
        }
      : undefined
  const onMoreSheetCloseAutoFocus = (event: Event): void => {
    if (skipMoreSheetFocusRef.current) {
      skipMoreSheetFocusRef.current = false
      event.preventDefault()
      return
    }
    moreSheetCloseAutoFocus(event)
  }

  // Header ⋯ "Close chat": the same teardown the drawer's Recents rows use, which
  // asks the idle-shutdown guard before the tab goes.
  const closeActiveChat = (): void => {
    if (activeTab?.type !== 'agent-chat') return
    const tabId = activeTab.id
    requestCloseAgentChat(activeTab.sessionId, () => {
      useWorkspaceStore.getState().removeTab(tabId)
    })
  }

  // The navigation rows both ⋯ sheets offer, gated once: the header sheet for a
  // chat or tab, the terminal sheet for a terminal. Git and Files record ⋯ as
  // the opener so focus returns there when their sheet closes.
  const openGitChangesFromSheet =
    !isTauriContext() && activeProject?.path && onOpenGitChanges
      ? () => {
          recordSheetOpener('git-sheet', moreButtonRef.current)
          onOpenGitChanges()
        }
      : undefined
  const openFilesFromSheet = !isTauriContext()
    ? () => {
        recordSheetOpener('files-sheet', moreButtonRef.current)
        setFilesOpen(true)
      }
    : undefined
  const openCommandPalette = !isTauriContext() ? onOpenCommandPalette : undefined
  const openProjectSettings = activeProject ? onOpenProjectSettings : undefined

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-mobile-chat-shell="">
      {/* Shell live region. Mounted once at the root, outside the header, the
          body and every Sheet or Portal, and never unmounted while the shell
          lives, so announcements fire whether or not the drawer is open. The
          explicit aria-live keeps it out of Radix hideOthers (aria-hidden
          skips [aria-live] nodes). Never mounted holding text: the announcer
          store clears it before every new message. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-shell-live-region=""
      >
        {announcement}
      </div>
      <MobileShellHeader
        title={headerTitle}
        subtitleText={subtitle.text}
        subtitleLabel={subtitle.label}
        drawerOpen={drawerOpen}
        onOpenDrawer={openDrawer}
        menuButtonRef={menuButtonRef}
        projectSheetOpen={projectsOpen}
        onOpenProjectSheet={openProjectSheet}
        attentionCount={attentionCount}
        isTerminal={isTerminalTab}
        canNewChat={canNewChat}
        onNewChat={onNewChat}
        onNewTerminal={newTerminal}
        moreOpen={isTerminalTab ? terminalSheetOpen : moreOpen}
        onOpenMore={() => {
          if (isTerminalTab) {
            recordSheetOpener('terminal-actions-sheet', moreButtonRef.current)
            setTerminalActionsOpen(true)
          } else {
            recordSheetOpener('header-more-sheet', moreButtonRef.current)
            setMoreOpen(true)
          }
        }}
        moreButtonRef={moreButtonRef}
        subtitleRef={subtitleRef}
        titleRef={titleRef}
      />

      {/* flex flex-col so the workspace child can size via flex-1 instead of
          height:100% — percentages against this flex-sized wrapper collapse
          to 0 in engines that treat flex-resolved sizes as indefinite. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      {showTerminalControls && activeTerminal?.ptyId ? (
        <MobileTerminalControls terminalId={activeTerminal.ptyId} />
      ) : null}

      <MobileShellDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        section={drawerSection}
        attentionCount={attentionCount}
        activeTabId={activeTab?.id ?? null}
        activeSessionId={activeSessionId}
        canNewChat={canNewChat}
        onNewChat={onNewChat}
        onNewTerminal={newTerminal}
        onCloseTerminal={onCloseTerminal}
        onRenameTerminal={onRenameTerminal}
        onCloseEditorTab={onCloseEditorTab}
        onOpenGitHistory={openGitHistory}
        onOpenProjects={openProjectSheet}
        onOpenFiles={openFilesFrom ? () => openFilesFrom(menuButtonRef.current) : undefined}
      />

      {!isTauriContext() && (
        <ProjectSwitcherDrawer
          open={projectsOpen}
          onOpenChange={setProjectsOpen}
          onAddProject={onNewProject}
          side="bottom"
          id="mobile-project-sheet"
          onCloseAutoFocus={projectSheetCloseAutoFocus}
        />
      )}

      {!isTauriContext() && (
        <MobileFileExplorer
          open={filesOpen}
          onOpenChange={setFilesOpen}
          onFileOpened={() => {
            setSheetFocusDestination('files-sheet', titleRef.current)
            returnToWorkspace()
          }}
        />
      )}

      <MobileHeaderMoreSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title={headerTitle}
        subtitle={subtitle.text}
        onCloseAutoFocus={onMoreSheetCloseAutoFocus}
        onItemChosen={() => setSheetFocusDestination('header-more-sheet', titleRef.current)}
        onOpenGitChanges={openGitChangesFromSheet}
        onOpenFiles={openFilesFromSheet}
        onOpenCommandPalette={openCommandPalette}
        onNewTerminal={newTerminal}
        onOpenProjectSettings={openProjectSettings}
        onCloseChat={activeTab?.type === 'agent-chat' ? closeActiveChat : undefined}
        onCloseTab={closeActiveOtherTab}
      />

      {activeTab?.type === 'terminal' && (
        <MobileTerminalActionsSheet
          open={terminalSheetOpen}
          onOpenChange={setTerminalActionsOpen}
          terminalId={activeTab.terminalId}
          tabId={activeTab.id}
          name={terminalName}
          lastExitCode={activeTerminal?.lastExitCode}
          onCloseAutoFocus={terminalSheetCloseAutoFocus}
          onItemChosen={() => setSheetFocusDestination('terminal-actions-sheet', titleRef.current)}
          onRenameTerminal={onRenameTerminal}
          onRestartTerminal={onRestartTerminal}
          onOpenCommandHistory={onOpenCommandHistory}
          onOpenGitChanges={openGitChangesFromSheet}
          onOpenFiles={openFilesFromSheet}
          onOpenCommandPalette={openCommandPalette}
          onOpenProjectSettings={openProjectSettings}
          onCloseTerminal={onCloseTerminal}
        />
      )}
    </div>
  )
}
