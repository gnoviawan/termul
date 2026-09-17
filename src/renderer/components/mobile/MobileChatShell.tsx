import {
  Camera,
  FolderGit2,
  FolderTree,
  GitBranch,
  Globe,
  History,
  Menu,
  MessageSquarePlus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  TerminalSquare,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChatHistoryTab } from '@/components/chat/ChatHistoryTab'
import { ProjectSwitcherDrawer } from '@/components/chat/ProjectSwitcherDrawer'
import { TermulMark } from '@/components/TermulMark'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useEditorStore } from '@/stores/editor-store'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { useActiveProject } from '@/stores/project-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { getAllLeafPanes, useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'
import { MobileFileExplorer } from './MobileFileExplorer'
import { MobileTerminalControls } from './MobileTerminalControls'

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
  onCloseTerminal?: (terminalId: string, tabId: string) => void
  onRenameTerminal?: (terminalId: string, name: string) => void
  onRestartTerminal?: (terminalId: string) => void
  /**
   * Opens the New Project modal (Story 7, QA "no mobile creation entry"):
   * offered in BOTH the header action row and the drawer action row so a
   * second project can be created once at least one exists (the zero-project
   * empty state is no longer the only path).
   */
  onNewProject?: () => void
  /**
   * Close an editor tab through the dirty-file guard (WorkspaceLayout
   * `handleCloseEditorTab` semantics) so drawer closes never silently
   * discard unsaved changes.
   */
  onCloseEditorTab?: (filePath: string) => void
}

/**
 * ChatGPT-style mobile web chrome: slim header + slide-out chat list drawer.
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
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const navigate = useNavigate()
  const activeProject = useActiveProject()

  // Story 6: the mobile drawer is the mobile tab strip. Register the shell's
  // three sheets in the overlay stack so hardware back (popstate) closes the
  // topmost one instead of exiting the app.
  useOverlayRegistration('mobile-drawer', drawerOpen, () => setDrawerOpen(false))
  useOverlayRegistration('projects-sheet', projectsOpen, () => setProjectsOpen(false))
  useOverlayRegistration('files-sheet', filesOpen, () => setFilesOpen(false))

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

  // ALL pane tabs across every leaf (terminal, editor, git, git-history,
  // browser, agent-chat). Story 6: the drawer lists every tab with a close
  // affordance so non-terminal tabs are no longer one-way dead ends on
  // mobile. Derive via useMemo from the stable `root` reference so the
  // wrapper objects are only rebuilt when the tree actually changes.
  const workspaceRoot = useWorkspaceStore((s) => s.root)
  const paneTabs = useMemo(() => {
    const leaves = getAllLeafPanes(workspaceRoot)
    return leaves.flatMap((leaf) => (leaf.tabs ?? []).map((t) => ({ tab: t, paneId: leaf.id })))
  }, [workspaceRoot])

  // Terminal rows keep their rename affordance; other tabs render a plain row.
  const terminalTabs = useMemo(
    () => paneTabs.flatMap(({ tab, paneId }) => (tab.type === 'terminal' ? [{ tab, paneId }] : [])),
    [paneTabs]
  )

  // Non-terminal tabs are the QA F3 trap: they render in the drawer with a
  // close button routed through the correct teardown path.
  const nonTerminalTabs = useMemo(
    () => paneTabs.filter(({ tab }) => tab.type !== 'terminal'),
    [paneTabs]
  )

  // Editor dirty state for the drawer's dirty dots. Subscribe to the whole
  // openFiles map reference (stable unless a file opens/closes) and resolve
  // dirtiness per-row — a Map is stable across `isDirty` flips only when the
  // store replaces entries; zustand's set() always produces a new Map, so
  // this re-renders exactly when openFiles changes.
  const openFiles = useEditorStore((s) => s.openFiles)
  const isEditorFileDirty = (filePath: string): boolean => openFiles.get(filePath)?.isDirty ?? false

  // Browser tab labels (title → host → 'Browser'), mirroring WorkspaceTabBar.
  const browserTabs = useBrowserSessionStore((s) => s.tabs)
  const browserLabel = (browserTabId: string): string => {
    const t = browserTabs.get(browserTabId)
    if (t?.title.trim()) return t.title.trim()
    if (t?.url) {
      try {
        const parsed = new URL(t.url)
        return parsed.host || parsed.hostname || t.url
      } catch {
        return t.url.replace(/^https?:\/\//, '').split('/')[0] || 'Browser'
      }
    }
    return 'Browser'
  }

  // Agent-chat labels: live session title → index entry → 'Agent Chat'.
  const acpSessions = useAcpStore((s) => s.sessions)
  const acpSessionIndex = useAcpStore((s) => s.sessionIndex)
  const agentChatLabel = (sessionId: string): string => {
    const live = acpSessions[sessionId]?.title
    if (live) return live
    return acpSessionIndex.find((e) => e.id === sessionId)?.title ?? 'Agent Chat'
  }

  const activeSessionId = activeTab?.type === 'agent-chat' ? activeTab.sessionId : null

  const sessionTitle = useAcpStore((s) => {
    if (!activeSessionId) return null
    const live = s.sessions[activeSessionId]?.title
    if (live) return live
    return s.sessionIndex.find((e) => e.id === activeSessionId)?.title ?? null
  })

  const headerTitle = useMemo(() => {
    if (activeTerminal?.name) return activeTerminal.name
    if (sessionTitle) return sessionTitle
    if (activeProject?.name) return activeProject.name
    return 'Termul'
  }, [activeTerminal?.name, sessionTitle, activeProject?.name])

  const closeDrawer = (): void => setDrawerOpen(false)

  // Select any pane tab from a drawer row (generalized selectTerminal) and
  // close the drawer. Agent-chat selection routes through setActiveTab which
  // also navigates to the chat session.
  const selectTab = (paneId: string, tabId: string): void => {
    const workspace = useWorkspaceStore.getState()
    if (workspace.activePaneId !== paneId) {
      // Defer tab activation until pane is active.
      requestAnimationFrame(() => {
        useWorkspaceStore.getState().setActiveTab(paneId, tabId)
      })
    } else {
      workspace.setActiveTab(paneId, tabId)
    }
    closeDrawer()
  }

  // Close routing per tab type — mirror of the (hidden) WorkspaceTabBar
  // close semantics so the drawer never silently bypasses a guard:
  //   editor → dirty guard (threaded from WorkspaceLayout)
  //   terminal → existing confirm flow (threaded as onCloseTerminal)
  //   browser → session-tab teardown + tab removal
  //   git / git-history / agent-chat → plain removeTab
  const closePaneTab = (tab: WorkspaceTab): void => {
    if (tab.type === 'editor') {
      if (onCloseEditorTab) {
        onCloseEditorTab(tab.filePath)
      } else {
        // No guard threaded: fall back to direct close (still not silent
        // data loss in practice — the editor auto-save policy owns unsaved
        // content; the guard path is the wired default).
        useWorkspaceStore.getState().removeTab(tab.id)
      }
      return
    }
    if (tab.type === 'terminal') {
      onCloseTerminal?.(tab.terminalId, tab.id)
      return
    }
    if (tab.type === 'browser') {
      useBrowserSessionStore.getState().removeTab(tab.browserTabId)
      useWorkspaceStore.getState().removeTab(tab.id)
      return
    }
    useWorkspaceStore.getState().removeTab(tab.id)
  }
  const startRename = (terminalId: string, currentName: string): void => {
    setRenamingId(terminalId)
    setRenameValue(currentName)
  }

  const confirmRename = (): void => {
    if (renamingId && renameValue.trim() && onRenameTerminal) {
      onRenameTerminal(renamingId, renameValue.trim())
    }
    setRenamingId(null)
    setRenameValue('')
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-mobile-chat-shell="">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10 shrink-0"
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          aria-controls={drawerOpen ? 'mobile-chat-drawer' : undefined}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu size={20} />
        </Button>

        <div className="min-w-0 flex-1 text-center">
          <h1 className="truncate text-sm font-medium text-foreground">{headerTitle}</h1>
        </div>

        {!isTauriContext() && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0"
            aria-label="Switch project"
            onClick={() => setProjectsOpen(true)}
          >
            <FolderGit2 size={20} />
          </Button>
        )}

        {!isTauriContext() && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0"
            aria-label="Browse files"
            aria-expanded={filesOpen}
            onClick={() => setFilesOpen(true)}
          >
            <FolderTree size={20} />
          </Button>
        )}

        {!isTauriContext() && onOpenCommandPalette && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0"
            aria-label="Command palette"
            onClick={onOpenCommandPalette}
          >
            <Search size={20} />
          </Button>
        )}

        {/* Story 7 (QA "no mobile creation entry"): a New Project entry in
            the header action row, web mode only — the zero-project empty
            state CTA is no longer the only creation path on mobile. */}
        {!isTauriContext() && onNewProject && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0"
            aria-label="New project"
            onClick={onNewProject}
          >
            <Plus size={20} />
          </Button>
        )}

        {!isTauriContext() && onOpenGitChanges && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0"
            aria-label="Git changes"
            disabled={!activeProject?.path}
            onClick={onOpenGitChanges}
          >
            <GitBranch size={20} />
          </Button>
        )}

        {activeTab?.type === 'terminal' ? (
          <>
            {onRestartTerminal && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-10 shrink-0"
                aria-label="Restart terminal"
                onClick={() => onRestartTerminal(activeTab.terminalId)}
              >
                <RotateCcw size={18} />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10 shrink-0"
              aria-label="Close terminal"
              onClick={() => onCloseTerminal?.(activeTab.terminalId, activeTab.id)}
            >
              <X size={20} />
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0"
            aria-label="New chat"
            disabled={!canNewChat}
            onClick={onNewChat}
          >
            <MessageSquarePlus size={20} />
          </Button>
        )}
      </header>

      {/* flex flex-col so the workspace child can size via flex-1 instead of
          height:100% — percentages against this flex-sized wrapper collapse
          to 0 in engines that treat flex-resolved sizes as indefinite. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      {activeTab?.type === 'terminal' && activeTerminal?.ptyId ? (
        <MobileTerminalControls terminalId={activeTerminal.ptyId} />
      ) : null}

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="left"
          id="mobile-chat-drawer"
          className="flex w-[min(100vw-3rem,20rem)] flex-col gap-0 p-0 sm:max-w-sm"
        >
          <SheetHeader className="space-y-0 border-b border-border/60 px-4 py-3 text-left">
            <div className="flex items-center gap-2 pr-8">
              <TermulMark size={20} />
              <SheetTitle className="text-base">Chats</SheetTitle>
            </div>
            <SheetDescription className="sr-only">
              Browse and open agent chat sessions
            </SheetDescription>
          </SheetHeader>

          <div className="flex shrink-0 gap-2 border-b border-border/60 p-2">
            <Button
              type="button"
              variant="secondary"
              className="h-9 flex-1 justify-start gap-2"
              disabled={!canNewChat}
              onClick={() => {
                closeDrawer()
                onNewChat()
              }}
            >
              <MessageSquarePlus size={16} />
              New chat
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0"
              aria-label="Settings"
              onClick={() => {
                closeDrawer()
                useSettingsModalStore.getState().openApp()
              }}
            >
              <Settings size={16} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0"
              aria-label="Snapshots"
              onClick={() => {
                closeDrawer()
                navigate('/snapshots')
              }}
            >
              <Camera size={16} />
            </Button>
            {!isTauriContext() && onNewProject && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 shrink-0"
                aria-label="New project"
                onClick={() => {
                  closeDrawer()
                  onNewProject()
                }}
              >
                <Plus size={16} />
              </Button>
            )}
            {!isTauriContext() && onOpenGitHistory && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 shrink-0"
                aria-label="Git history"
                disabled={!activeProject?.path}
                onClick={() => {
                  closeDrawer()
                  onOpenGitHistory()
                }}
              >
                <History size={16} />
              </Button>
            )}
          </div>

          <div className="border-b border-border/60 p-2">
            <div className="mb-1 flex items-center justify-between px-2 text-xs font-medium text-muted-foreground">
              <span>Terminals</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="New terminal"
                onClick={() => {
                  closeDrawer()
                  onNewTerminal?.()
                }}
              >
                <Plus size={16} />
              </Button>
            </div>
            {terminalTabs.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">No open terminals</p>
            ) : (
              terminalTabs.map(({ tab, paneId }) => {
                const terminal = useTerminalStore
                  .getState()
                  .terminals.find((item) => item.id === tab.terminalId)
                const isActive = tab.id === activeTab?.id
                const isRenaming = renamingId === tab.terminalId
                return (
                  <div key={tab.id} className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant={isActive ? 'secondary' : 'ghost'}
                      className="h-10 flex-1 justify-start gap-2"
                      onClick={() => selectTab(paneId, tab.id)}
                    >
                      <TerminalSquare size={16} />
                      <span className="truncate">{terminal?.name ?? 'Terminal'}</span>
                    </Button>
                    {isRenaming ? (
                      <input
                        type="text"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={confirmRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') confirmRename()
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        className="h-8 w-24 rounded border border-border bg-background px-2 text-xs"
                        autoFocus
                      />
                    ) : (
                      onRenameTerminal && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0"
                          aria-label="Rename terminal"
                          onClick={() => startRename(tab.terminalId, terminal?.name ?? 'Terminal')}
                        >
                          <Pencil size={14} />
                        </Button>
                      )
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label={`Close ${terminal?.name ?? 'terminal'}`}
                      onClick={() => closePaneTab(tab)}
                    >
                      <X size={14} />
                    </Button>
                  </div>
                )
              })
            )}
          </div>

          {/* Story 6: non-terminal tabs. On mobile the WorkspaceTabBar is
              hidden (PaneContent gates it on `isMobileWebShell`), so without
              this section every editor/git/git-history/browser tab is a
              one-way dead end. Each row closes through the same teardown
              path the hidden tab bar would use. */}
          {nonTerminalTabs.length > 0 && (
            <div className="border-b border-border/60 p-2">
              <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">Tabs</div>
              {nonTerminalTabs.map(({ tab, paneId }) => {
                const isActive = tab.id === activeTab?.id
                return (
                  <div key={tab.id} className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant={isActive ? 'secondary' : 'ghost'}
                      className="h-10 flex-1 justify-start gap-2"
                      onClick={() => selectTab(paneId, tab.id)}
                    >
                      {tab.type === 'editor' && (
                        <>
                          <Pencil size={16} />
                          <span className="truncate">
                            {tab.filePath.split(/[\\/]/).pop() ?? tab.filePath}
                          </span>
                          {isEditorFileDirty(tab.filePath) && (
                            <span
                              data-testid="editor-dirty-dot"
                              aria-label="Unsaved changes"
                              className="ml-1 size-1.5 shrink-0 rounded-full bg-primary"
                            />
                          )}
                        </>
                      )}
                      {tab.type === 'git' && (
                        <>
                          <GitBranch size={16} />
                          <span className="truncate">Git Changes</span>
                        </>
                      )}
                      {tab.type === 'git-history' && (
                        <>
                          <History size={16} />
                          <span className="truncate">Git History</span>
                        </>
                      )}
                      {tab.type === 'browser' && (
                        <>
                          <Globe size={16} />
                          <span className="truncate">{browserLabel(tab.browserTabId)}</span>
                        </>
                      )}
                      {tab.type === 'agent-chat' && (
                        <>
                          <MessageSquarePlus size={16} />
                          <span className="truncate">{agentChatLabel(tab.sessionId)}</span>
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      aria-label={`Close ${
                        tab.type === 'editor'
                          ? (tab.filePath.split(/[\\/]/).pop() ?? 'editor tab')
                          : tab.type === 'browser'
                            ? browserLabel(tab.browserTabId)
                            : tab.type === 'agent-chat'
                              ? agentChatLabel(tab.sessionId)
                              : tab.type === 'git'
                                ? 'git changes'
                                : 'git history'
                      }`}
                      onClick={() => closePaneTab(tab)}
                    >
                      <X size={14} />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-hidden">
            <ChatHistoryTab onSessionOpened={closeDrawer} />
          </div>
        </SheetContent>
      </Sheet>

      {!isTauriContext() && (
        <ProjectSwitcherDrawer open={projectsOpen} onOpenChange={setProjectsOpen} />
      )}

      {!isTauriContext() && <MobileFileExplorer open={filesOpen} onOpenChange={setFilesOpen} />}
    </div>
  )
}
