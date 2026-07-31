import { FolderGit2, FolderTree, Menu, MessageSquarePlus, Settings } from 'lucide-react'
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
import { useActiveProject } from '@/stores/project-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import { MobileFileExplorer } from './MobileFileExplorer'

interface MobileChatShellProps {
  children: React.ReactNode
  /** Opens the New Agent Chat launcher. */
  onNewChat: () => void
  /** Whether a new chat can be started (active project has a path). */
  canNewChat?: boolean
}

/**
 * ChatGPT-style mobile web chrome: slim header + slide-out chat list drawer.
 * Desktop IDE chrome (ActivityRail, TitleBar, persistent sidebar, tab strip)
 * stays outside this component and must be gated by `useMobileWebShell`.
 */
export function MobileChatShell({
  children,
  onNewChat,
  canNewChat = false
}: MobileChatShellProps): React.JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const navigate = useNavigate()
  const activeProject = useActiveProject()

  const activeSessionId = useWorkspaceStore((s) => {
    // Walk the pane tree once (not twice) and return a primitive sessionId —
    // no `useShallow` needed for a primitive selector.
    const leaves = getAllLeafPanes(s.root)
    const pane = leaves.find((p) => p.id === s.activePaneId) ?? leaves[0]
    const tab = pane?.tabs.find((t) => t.id === pane.activeTabId)
    return tab?.type === 'agent-chat' ? tab.sessionId : null
  })

  const sessionTitle = useAcpStore((s) => {
    if (!activeSessionId) return null
    const live = s.sessions[activeSessionId]?.title
    if (live) return live
    return s.sessionIndex.find((e) => e.id === activeSessionId)?.title ?? null
  })

  const headerTitle = useMemo(() => {
    if (sessionTitle) return sessionTitle
    if (activeProject?.name) return activeProject.name
    return 'Termul'
  }, [sessionTitle, activeProject?.name])

  const closeDrawer = (): void => setDrawerOpen(false)

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
            onClick={() => setFilesOpen(true)}
          >
            <FolderTree size={20} />
          </Button>
        )}

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
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>

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
                navigate('/preferences')
              }}
            >
              <Settings size={16} />
            </Button>
          </div>

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
