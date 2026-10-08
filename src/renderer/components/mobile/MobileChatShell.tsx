import { useMemo, useRef, useState } from 'react'
import { ProjectSwitcherDrawer } from '@/components/chat/ProjectSwitcherDrawer'
import {
  FolderGit2,
  FolderTree,
  GitBranch,
  Menu,
  MessageSquarePlus,
  Plus,
  RotateCcw,
  Search,
  X
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { useActiveProject } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import { MobileFileExplorer } from './MobileFileExplorer'
import { MobileShellDrawer } from './MobileShellDrawer'
import { MobileTerminalControls } from './MobileTerminalControls'

/**
 * Header icon hit box. The shell header is h-12 (48px), so 44px (`size-11`)
 * fits without growing the row or covering the title (#881). `size="icon"`
 * is 40px; this class wins via tailwind-merge.
 */
const HEADER_ICON_BUTTON = 'size-11 shrink-0'

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
   * offered in the header action row and as the project sheet's Add project,
   * so a second project can be created once at least one exists (the
   * zero-project empty state is no longer the only path).
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
  const activeProject = useActiveProject()
  // The drawer returns focus to whatever opened it. ☰ is the only opener today
  // and the fallback when a recorded opener is gone; the pill and project
  // subtitle (header goal) go through `openDrawer` too.
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const drawerOpenerRef = useRef<HTMLElement | null>(null)
  const openDrawer = (opener: HTMLElement | null): void => {
    drawerOpenerRef.current = opener ?? menuButtonRef.current
    setDrawerOpen(true)
  }

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-mobile-chat-shell="">
      {/* Story 11 (QA F9): the header previously laid 7 equal-weight
          shrink-0 icon buttons beside a flex-1 title — at 360-375px with a
          terminal active the title collapsed to ~0. Fix: (1) the title now
          has a guaranteed min-width (flex-1 min-w-[6rem]) so it always
          truncates instead of vanishing; (2) trailing actions are grouped
          in one shrinkable cluster so the layout degrades the action row,
          never the title. Order stays stable (menu | title | actions). */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <Button
          ref={menuButtonRef}
          type="button"
          variant="ghost"
          size="icon"
          className={HEADER_ICON_BUTTON}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          aria-controls={drawerOpen ? 'mobile-shell-drawer' : undefined}
          onClick={(e) => openDrawer(e.currentTarget)}
        >
          <Menu size={20} />
        </Button>

        <div className="min-w-16 flex-1 truncate text-center" data-mobile-header-title="">
          <h1 className="truncate text-sm font-medium text-foreground">{headerTitle}</h1>
        </div>

        <div className="flex min-w-0 shrink items-center justify-end gap-0.5 overflow-x-auto scrollbar-hide">
          {!isTauriContext() && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={HEADER_ICON_BUTTON}
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
              className={HEADER_ICON_BUTTON}
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
              className={HEADER_ICON_BUTTON}
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
              className={HEADER_ICON_BUTTON}
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
              className={HEADER_ICON_BUTTON}
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
                  className={HEADER_ICON_BUTTON}
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
                className={HEADER_ICON_BUTTON}
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
              className={HEADER_ICON_BUTTON}
              aria-label="New chat"
              disabled={!canNewChat}
              onClick={onNewChat}
            >
              <MessageSquarePlus size={20} />
            </Button>
          )}
        </div>
      </header>

      {/* flex flex-col so the workspace child can size via flex-1 instead of
          height:100% — percentages against this flex-sized wrapper collapse
          to 0 in engines that treat flex-resolved sizes as indefinite. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      {activeTab?.type === 'terminal' && activeTerminal?.ptyId ? (
        <MobileTerminalControls terminalId={activeTerminal.ptyId} />
      ) : null}

      <MobileShellDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        activeTabId={activeTab?.id ?? null}
        activeSessionId={activeSessionId}
        canNewChat={canNewChat}
        onNewChat={onNewChat}
        onNewTerminal={onNewTerminal}
        onCloseTerminal={onCloseTerminal}
        onRenameTerminal={onRenameTerminal}
        onCloseEditorTab={onCloseEditorTab}
        onOpenGitHistory={onOpenGitHistory}
        onOpenProjects={() => setProjectsOpen(true)}
        returnFocusRef={drawerOpenerRef}
        menuButtonRef={menuButtonRef}
      />

      {!isTauriContext() && (
        <ProjectSwitcherDrawer
          open={projectsOpen}
          onOpenChange={setProjectsOpen}
          onAddProject={onNewProject}
        />
      )}

      {!isTauriContext() && <MobileFileExplorer open={filesOpen} onOpenChange={setFilesOpen} />}
    </div>
  )
}
