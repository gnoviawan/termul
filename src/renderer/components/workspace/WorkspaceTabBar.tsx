import type { DetectedShells, ShellInfo } from '@shared/types/ipc.types'
import { motion, useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { AgentIcon } from '@/components/agents/AgentIcon'
import { AgentBadge } from '@/components/chat/AgentBadge'
import { AgentConnectionLamp } from '@/components/chat/AgentConnectionLamp'
import { isAgentConnected } from '@/components/chat/is-agent-connected'
import {
  CircleDot,
  GitBranch,
  Globe,
  History,
  Loader2,
  Maximize2,
  Minimize2,
  Terminal as TerminalIcon,
  X as XIcon
} from '@/components/icons'
import { Skeleton } from '@/components/ui/skeleton'
import { requestCloseAgentChat } from '@/hooks/use-agent-idle-shutdown'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import { agentChatNeedsAttention } from '@/lib/agent-chat-attention'
import { clipboardApi, shellApi } from '@/lib/api'
import { browserTabHide, browserTabShow } from '@/lib/browser-api'
import { logFrontendError } from '@/lib/log-api'
import { EASE_OUT } from '@/lib/motion'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import {
  isEphemeralAcpSession,
  useAcpStore,
  useAgentIdentity,
  useSessionIndexTitle
} from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useEditorStore } from '@/stores/editor-store'
import { type GitStatusState, useGitStatusStore } from '@/stores/git-status-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { editorTabId, useLeafCount, useWorkspaceStore } from '@/stores/workspace-store'
import type { Terminal } from '@/types/project'
import type { TabReorderPosition } from '@/types/workspace.types'
import { EditorTab, TAB_CLOSE_BUTTON_CLASS, TabCloseReveal } from './EditorTab'
import { handleTabAuxClick, type TabBulkMenuProps, TabContextMenu } from './tab-context-menu'

// Helper to compute drop position from mouse coordinates
function computeTabPosition(target: HTMLElement, clientX: number): TabReorderPosition {
  const rect = target.getBoundingClientRect()
  const x = clientX - rect.left
  const halfWidth = rect.width / 2
  return x < halfWidth ? 'before' : 'after'
}

// Inline TerminalTab matching the style from TerminalTabBar

interface TerminalTabInlineProps {
  terminal: Terminal
  isActive: boolean
  isDragging: boolean
  isDropTarget: boolean
  dropPosition: TabReorderPosition | null
  isClosing?: boolean
  bulkMenu: TabBulkMenuProps
  onSelect: () => void
  onClose: () => void
  onRename: (name: string) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}

function TerminalTabInline({
  terminal,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  isClosing = false,
  bulkMenu,
  onSelect,
  onClose,
  onRename,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: TerminalTabInlineProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(terminal.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleDoubleClick = useCallback(() => {
    setEditName(terminal.name)
    setIsEditing(true)
  }, [terminal.name])

  const handleSave = useCallback(() => {
    const trimmedName = editName.trim()
    if (trimmedName && trimmedName !== terminal.name) {
      onRename(trimmedName)
    }
    setIsEditing(false)
  }, [editName, terminal.name, onRename])

  const handleCancel = useCallback(() => {
    setEditName(terminal.name)
    setIsEditing(false)
  }, [terminal.name])

  const handleRenameFromMenu = useCallback(() => {
    setEditName(terminal.name)
    setIsEditing(true)
  }, [terminal.name])

  return (
    <TabContextMenu
      kind="terminal"
      onClose={onClose}
      onRename={handleRenameFromMenu}
      isClosing={isClosing}
      {...bulkMenu}
    >
      <div
        draggable={!isEditing}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onSelect}
        // Middle-click is a no-op while the inline rename input is editing.
        onAuxClick={(e) => handleTabAuxClick(e, onClose, isClosing || isEditing)}
        className={cn(
          'relative h-full px-3 flex items-center border-r border-border min-w-[100px] cursor-pointer group transition-[opacity,transform,background-color] duration-150 ease-out',
          isActive ? 'bg-background' : 'hover:bg-secondary/50 text-muted-foreground',
          isDragging && 'opacity-50 scale-[0.98]'
        )}
      >
        {/* Drop indicator line */}
        {isDropTarget && dropPosition === 'before' && (
          <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
        )}
        {isDropTarget && dropPosition === 'after' && (
          <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
        )}

        <div className={cn('flex min-w-0 items-center', isEditing && 'flex-1')}>
          {terminal.kind === 'agent' && terminal.agentId ? (
            <AgentIcon
              agentId={terminal.agentId}
              name={terminal.agentName}
              className="h-3 w-3 shrink-0"
            />
          ) : (
            <TerminalIcon size={12} className={cn('shrink-0', isActive ? 'text-primary' : '')} />
          )}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleSave()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  handleCancel()
                }
              }}
              onBlur={handleSave}
              onClick={(e) => e.stopPropagation()}
              onAuxClick={(e) => e.stopPropagation()}
              className="ml-2 min-w-0 flex-1 bg-transparent text-2xs font-medium border-b border-primary outline-none"
            />
          ) : (
            <span
              onDoubleClick={handleDoubleClick}
              className={cn(
                'ml-2 min-w-0 truncate text-2xs font-medium',
                isActive && 'text-foreground'
              )}
            >
              {terminal.name}
            </span>
          )}
        </div>
        <TabCloseReveal pinned={isActive || isClosing}>
          <button
            type="button"
            tabIndex={isActive || isClosing ? undefined : -1}
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              if (!isClosing) {
                onClose()
              }
            }}
            disabled={isClosing}
            className={cn(TAB_CLOSE_BUTTON_CLASS, isClosing && 'disabled:cursor-wait')}
          >
            {isClosing ? (
              <Loader2 size={11} className="animate-spin motion-reduce:animate-none" />
            ) : (
              <XIcon size={11} />
            )}
          </button>
        </TabCloseReveal>
      </div>
    </TabContextMenu>
  )
}

interface EditorTabWrapperProps {
  tab: { type: 'editor'; id: string; filePath: string }
  isActive: boolean
  isDragging: boolean
  isDropTarget: boolean
  dropPosition: TabReorderPosition | null
  bulkMenu: TabBulkMenuProps
  onSelect: () => void
  onClose: () => void
  onCopyPath: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}

function EditorTabWrapper({
  tab,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  bulkMenu,
  onSelect,
  onClose,
  onCopyPath,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: EditorTabWrapperProps): React.JSX.Element {
  const { isDirty, operationStatus } = useEditorStore(
    useShallow((state) => {
      const file = state.openFiles.get(tab.filePath)
      return {
        isDirty: file?.isDirty ?? false,
        operationStatus: file?.operationStatus ?? 'idle'
      }
    })
  )
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'relative h-full transition-[opacity,transform] duration-150 ease-out',
        isDragging && 'opacity-50 scale-[0.98]'
      )}
    >
      {/* Drop indicator line */}
      {isDropTarget && dropPosition === 'before' && (
        <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full z-10" />
      )}
      {isDropTarget && dropPosition === 'after' && (
        <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full z-10" />
      )}
      <EditorTab
        filePath={tab.filePath}
        isActive={isActive}
        isDirty={isDirty}
        operationStatus={operationStatus}
        onSelect={onSelect}
        onClose={onClose}
        onCopyPath={onCopyPath}
        {...bulkMenu}
      />
    </div>
  )
}

interface BrowserTabInlineProps {
  tab: { type: 'browser'; id: string; browserTabId: string }
  isActive: boolean
  isDragging: boolean
  isDropTarget: boolean
  dropPosition: TabReorderPosition | null
  bulkMenu: TabBulkMenuProps
  onSelect: () => void
  onClose: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}

function BrowserTabInline({
  tab,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  bulkMenu,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: BrowserTabInlineProps): React.JSX.Element {
  const browserTab = useBrowserSessionStore((state) => state.getTab(tab.browserTabId))
  const label = (() => {
    if (!browserTab) return 'Browser'
    if (browserTab.title.trim()) return browserTab.title.trim()
    if (browserTab.url) {
      try {
        const parsed = new URL(browserTab.url)
        return parsed.host || parsed.hostname || browserTab.url
      } catch {
        return browserTab.url.replace(/^https?:\/\//, '').split('/')[0] || 'Browser'
      }
    }
    return 'Browser'
  })()

  return (
    <TabContextMenu kind="browser" onClose={onClose} {...bulkMenu}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onSelect}
        onAuxClick={(e) => handleTabAuxClick(e, onClose)}
        className={cn(
          'relative h-full px-3 flex items-center border-r border-border min-w-[100px] cursor-pointer group transition-[opacity,transform,background-color] duration-150 ease-out',
          isActive ? 'bg-background' : 'hover:bg-secondary/50 text-muted-foreground',
          isDragging && 'opacity-50 scale-[0.98]'
        )}
      >
        {/* Drop indicator line */}
        {isDropTarget && dropPosition === 'before' && (
          <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
        )}
        {isDropTarget && dropPosition === 'after' && (
          <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full" />
        )}

        <div className="flex min-w-0 items-center">
          <Globe size={12} className={cn('shrink-0', isActive ? 'text-primary' : '')} />
          <span
            className={cn(
              'ml-2 min-w-0 truncate text-2xs font-medium',
              isActive && 'text-foreground'
            )}
          >
            {label}
          </span>
        </div>
        <TabCloseReveal pinned={isActive}>
          <button
            type="button"
            tabIndex={isActive ? undefined : -1}
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className={TAB_CLOSE_BUTTON_CLASS}
          >
            <XIcon size={11} />
          </button>
        </TabCloseReveal>
      </div>
    </TabContextMenu>
  )
}

function GitTabInline({
  tab,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  bulkMenu,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: {
  tab: { type: 'git'; id: string; cwd: string }
  isActive: boolean
  isDragging: boolean
  isDropTarget: boolean
  dropPosition: TabReorderPosition | null
  bulkMenu: TabBulkMenuProps
  onSelect: () => void
  onClose: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}) {
  const totalChanges = useGitStatusStore(
    (state: GitStatusState) => (state.statuses[tab.cwd] || []).length
  )

  return (
    <TabContextMenu kind="git" onClose={onClose} {...bulkMenu}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onSelect}
        onAuxClick={(e) => handleTabAuxClick(e, onClose)}
        className={cn(
          'group relative h-full px-3 flex items-center min-w-[120px] max-w-[200px] cursor-pointer select-none border-r border-border transition-[opacity,transform,background-color] duration-150 ease-out',
          isActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
          isDragging && 'opacity-50 scale-[0.98]',
          isDropTarget && dropPosition === 'before' && 'border-l-2 border-l-primary',
          isDropTarget && dropPosition === 'after' && 'border-r-2 border-r-primary'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch size={12} className={cn('shrink-0', isActive && 'text-primary')} />
          <span className="min-w-0 truncate text-2xs font-medium">Git Changes</span>
          {totalChanges > 0 && (
            <span
              className={cn(
                'px-1 min-w-[14px] h-3.5 flex shrink-0 items-center justify-center rounded-full text-4xs font-bold tabular-nums',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted-foreground/20 text-muted-foreground'
              )}
            >
              {totalChanges}
            </span>
          )}
        </div>
        <TabCloseReveal pinned={isActive}>
          <button
            type="button"
            tabIndex={isActive ? undefined : -1}
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className={TAB_CLOSE_BUTTON_CLASS}
          >
            <XIcon size={10} />
          </button>
        </TabCloseReveal>
      </div>
    </TabContextMenu>
  )
}

function GitHistoryTabInline({
  tab: _tab,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  bulkMenu,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: {
  tab: { type: 'git-history'; id: string; cwd: string }
  isActive: boolean
  isDragging: boolean
  isDropTarget: boolean
  dropPosition: TabReorderPosition | null
  bulkMenu: TabBulkMenuProps
  onSelect: () => void
  onClose: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}) {
  return (
    <TabContextMenu kind="git-history" onClose={onClose} {...bulkMenu}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onSelect}
        onAuxClick={(e) => handleTabAuxClick(e, onClose)}
        className={cn(
          'group relative h-full px-3 flex items-center min-w-[120px] max-w-[200px] cursor-pointer select-none border-r border-border transition-[opacity,transform,background-color] duration-150 ease-out',
          isActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
          isDragging && 'opacity-50 scale-[0.98]',
          isDropTarget && dropPosition === 'before' && 'border-l-2 border-l-primary',
          isDropTarget && dropPosition === 'after' && 'border-r-2 border-r-primary'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <History size={12} className={cn('shrink-0', isActive && 'text-primary')} />
          <span className="min-w-0 truncate text-2xs font-medium">Git History</span>
        </div>
        <TabCloseReveal pinned={isActive}>
          <button
            type="button"
            tabIndex={isActive ? undefined : -1}
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className={TAB_CLOSE_BUTTON_CLASS}
          >
            <XIcon size={10} />
          </button>
        </TabCloseReveal>
      </div>
    </TabContextMenu>
  )
}

function AgentChatTabInline({
  tab,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  bulkMenu,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: {
  tab: { type: 'agent-chat'; id: string; sessionId: string }
  isActive: boolean
  isDragging: boolean
  isDropTarget: boolean
  dropPosition: TabReorderPosition | null
  bulkMenu: TabBulkMenuProps
  onSelect: () => void
  onClose: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}) {
  const session = useAcpStore((s) => s.sessions[tab.sessionId])
  const agentStatus = useAcpStore((s) => (session ? s.agentStatus[session.agentId] : undefined))
  const isLaunchingSession = useAcpStore((s) => Boolean(s.launchingSessionIds[tab.sessionId]))
  const pendingPermission = useAcpStore((s) =>
    Object.values(s.pendingPermissions).some((permission) => permission.sessionId === tab.sessionId)
  )
  const pendingQuestion = useAcpStore((s) =>
    Object.values(s.pendingQuestions).some((question) => question.sessionId === tab.sessionId)
  )
  const closing = useAgentChatLifetimeStore((s) => Boolean(s.closingSessionIds[tab.sessionId]))
  const needsAttention = session
    ? agentChatNeedsAttention({
        projectId: session.projectId,
        sessionStatus: session.status,
        agentStatus,
        pendingPermission,
        pendingQuestion,
        ephemeral: isEphemeralAcpSession(session.id)
      })
    : false
  const { name: agentName } = useAgentIdentity(session?.agentId ?? null)
  // The persisted index entry carries the effective title (agent-pushed title,
  // first-message derivation, or "Untitled Chat N"). `session.title` stays null
  // until an event sets it, so fall through to the index entry for the label.
  // (Reused selector — the inline original was behaviorally identical: the
  // string return already suppressed unrelated sessionIndex rebuilds via
  // Object.is. Extraction is for reuse across call sites, not a behavior
  // change.)
  const indexTitle = useSessionIndexTitle(tab.sessionId)
  // Treat in-flight launcher handoff as connected so we don't flash a red
  // disconnected lamp on the optimistic placeholder chat.
  const connected = isLaunchingSession || isAgentConnected(session, agentStatus)
  const isClosed = session?.status === 'closed'
  const tabLabel = session?.title ?? indexTitle ?? agentName ?? 'Agent Chat'

  return (
    <TabContextMenu kind="agent-chat" onClose={onClose} isClosing={closing} {...bulkMenu}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onSelect}
        onAuxClick={(e) => handleTabAuxClick(e, onClose, closing)}
        aria-label={`${tabLabel}${closing ? ', Closing' : ''}${needsAttention ? ', Needs you' : ''}`}
        className={cn(
          'group relative h-full px-3 flex items-center min-w-[120px] max-w-[200px] cursor-pointer select-none border-r border-border transition-[opacity,transform,background-color] duration-150 ease-out',
          isActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
          isDragging && 'opacity-50 scale-[0.98]',
          isDropTarget && dropPosition === 'before' && 'border-l-2 border-l-primary',
          isDropTarget && dropPosition === 'after' && 'border-r-2 border-r-primary'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {session ? (
            <>
              <AgentBadge
                agentId={session.agentId}
                showName={false}
                iconSize={12}
                className="shrink-0"
              />
              <span
                className={cn(
                  'min-w-0 truncate text-2xs font-medium',
                  isClosed && 'line-through opacity-60',
                  isActive ? 'text-foreground' : 'text-inherit'
                )}
                title={tabLabel}
              >
                {tabLabel}
              </span>
              {closing ? (
                <span
                  className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
                  title="Closing. This chat stops when the turn finishes."
                >
                  <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden />
                  <span className="sr-only">Closing</span>
                </span>
              ) : null}
              {needsAttention ? (
                <span
                  className="inline-flex size-3.5 shrink-0 items-center justify-center text-warning"
                  title="Needs you"
                >
                  <CircleDot size={12} aria-hidden />
                  <span className="sr-only">Needs you</span>
                </span>
              ) : null}
              <AgentConnectionLamp connected={connected} />
            </>
          ) : (
            <span className="min-w-0 truncate text-2xs font-medium">Agent Chat</span>
          )}
        </div>
        <TabCloseReveal pinned={isActive}>
          <button
            type="button"
            tabIndex={isActive ? undefined : -1}
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className={TAB_CLOSE_BUTTON_CLASS}
          >
            <XIcon size={10} />
          </button>
        </TabCloseReveal>
      </div>
    </TabContextMenu>
  )
}

interface WorkspaceTabBarProps {
  paneId: string
  tabs: WorkspaceTab[]
  activeTabId: string | null
  closingTerminalIds?: string[]
  onAddTerminal?: (shell?: ShellInfo) => void
  onAddBrowserTab?: () => void
  onCloseTerminal?: (id: string, tabId: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  /**
   * Bulk close delegation: the tab bar computes the exact target list for
   * every "Close Other/All …" menu item and hands it to WorkspaceLayout,
   * which owns the single aggregate confirmation flow. When unset (tests),
   * each target closes through the per-tab close path instead.
   */
  onCloseTabs?: (tabs: WorkspaceTab[]) => void
  defaultShell?: string
}

export function WorkspaceTabBar({
  paneId,
  tabs,
  activeTabId,
  closingTerminalIds = [],
  onAddTerminal,
  onAddBrowserTab,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  onCloseTabs,
  defaultShell
}: WorkspaceTabBarProps): React.JSX.Element {
  const { setActiveTab, setActivePane, fullscreenPaneId, togglePaneFullscreen } = useWorkspaceStore(
    useShallow((state) => ({
      setActiveTab: state.setActiveTab,
      setActivePane: state.setActivePane,
      fullscreenPaneId: state.fullscreenPaneId,
      togglePaneFullscreen: state.togglePaneFullscreen
    }))
  )
  const leafCount = useLeafCount()
  const {
    startTabDrag,
    dragPayload,
    reorderPreview,
    setReorderPreview,
    clearReorderPreview,
    handleTabReorder
  } = usePaneDnd()
  // FLIP reorder feedback — instant under prefers-reduced-motion.
  const reducedMotion = useReducedMotion() ?? false

  const [isTerminalMenuOpen, setIsTerminalMenuOpen] = useState(false)
  const [shells, setShells] = useState<DetectedShells | null>(null)
  const [loading, setLoading] = useState(true)
  const [hasOverflow, setHasOverflow] = useState(false)
  const terminalMenuRef = useRef<HTMLDivElement>(null)
  const tabsContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const fetchShells = async (): Promise<void> => {
      try {
        const result = await shellApi.getAvailableShells()
        if (result.success) {
          setShells(result.data)
        }
      } catch {
        setShells(null)
      } finally {
        setLoading(false)
      }
    }
    void fetchShells()
  }, [])

  useEffect(() => {
    const handleClickOutside = (e: globalThis.MouseEvent): void => {
      if (terminalMenuRef.current && !terminalMenuRef.current.contains(e.target as Node)) {
        setIsTerminalMenuOpen(false)
      }
    }
    if (isTerminalMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isTerminalMenuOpen])

  // biome-ignore lint/correctness/useExhaustiveDependencies: tabs.length intentionally retriggers overflow checks
  useEffect(() => {
    const checkOverflow = (): void => {
      if (tabsContainerRef.current) {
        const { scrollWidth, clientWidth } = tabsContainerRef.current
        setHasOverflow(scrollWidth > clientWidth)
      }
    }
    checkOverflow()
    window.addEventListener('resize', checkOverflow)
    return () => window.removeEventListener('resize', checkOverflow)
  }, [tabs.length])

  // Native child webviews paint above the DOM, so the terminal popover would be
  // obscured unless we temporarily hide browser webviews while the menu is open.
  useEffect(() => {
    const browserTabs = tabs.filter(
      (tab): tab is WorkspaceTab & { type: 'browser'; browserTabId: string } =>
        tab.type === 'browser'
    )
    if (browserTabs.length === 0) return

    const hideAll = (tabsToHide: Array<{ browserTabId: string }>): void => {
      for (const tab of tabsToHide) {
        void browserTabHide(tab.browserTabId).catch(console.error)
      }
    }

    const showActive = (activeBrowserTab?: { browserTabId: string }): void => {
      if (activeBrowserTab) {
        void browserTabShow(activeBrowserTab.browserTabId).catch(console.error)
      }
    }

    if (isTerminalMenuOpen) {
      hideAll(browserTabs)
      return
    }

    const activeBrowserTab = browserTabs.find((tab) => tab.id === activeTabId)
    showActive(activeBrowserTab)
  }, [isTerminalMenuOpen, tabs, activeTabId])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (tabsContainerRef.current) {
      e.preventDefault()
      tabsContainerRef.current.scrollLeft += e.deltaY
    }
  }, [])

  const handleSelectShell = useCallback(
    (shell: ShellInfo) => {
      if (onAddTerminal) {
        onAddTerminal(shell)
      }
      setIsTerminalMenuOpen(false)
    },
    [onAddTerminal]
  )

  const handleCloseEditorTab = useCallback(
    (filePath: string) => {
      const operationStatus =
        useEditorStore.getState().openFiles.get(filePath)?.operationStatus ?? 'idle'
      if (operationStatus === 'saving' || operationStatus === 'reloading') {
        return
      }

      if (onCloseEditorTab) {
        onCloseEditorTab(filePath)
      } else {
        // Fallback: close from store directly
        const didClose = useEditorStore.getState().closeFileIfIdle(filePath)
        if (didClose) {
          useWorkspaceStore.getState().removeTab(editorTabId(filePath))
        }
      }
    },
    [onCloseEditorTab]
  )

  const handleTabDragStart = useCallback(
    (tabId: string, e: React.DragEvent) => {
      startTabDrag(tabId, paneId, e)
    },
    [startTabDrag, paneId]
  )

  const handleTabDragOver = useCallback(
    (tabId: string, e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'

      if (dragPayload?.type !== 'tab') return
      if (dragPayload.sourcePaneId !== paneId) return

      const position = computeTabPosition(e.currentTarget as HTMLElement, e.clientX)
      setReorderPreview(paneId, tabId, position)
    },
    [dragPayload, paneId, setReorderPreview]
  )

  const handleTabDragLeave = useCallback(() => {
    // Only clear if we're not entering a child element
    // This is handled by the individual tab components
  }, [])

  const handleContainerDragLeave = useCallback(
    (e: React.DragEvent) => {
      // Only clear preview if actually leaving the container (not moving to child)
      const relatedTarget = e.relatedTarget as Node | null
      if (relatedTarget && e.currentTarget.contains(relatedTarget)) {
        return
      }
      clearReorderPreview()
    },
    [clearReorderPreview]
  )

  const handleTabDrop = useCallback(
    (tabId: string, e: React.DragEvent) => {
      // Only prevent/stop if this is a same-pane tab reorder
      // Otherwise, let the event bubble for cross-pane drops
      if (dragPayload?.type !== 'tab' || dragPayload.sourcePaneId !== paneId) {
        return
      }

      e.preventDefault()
      e.stopPropagation()

      const position = computeTabPosition(e.currentTarget as HTMLElement, e.clientX)
      handleTabReorder(paneId, tabId, position)
    },
    [dragPayload, paneId, handleTabReorder]
  )

  const sortedShells = shells?.available?.slice().sort((a, b) => {
    if (defaultShell) {
      if (a.name === defaultShell) return -1
      if (b.name === defaultShell) return 1
    }
    return a.displayName.localeCompare(b.displayName)
  })

  // Multi-project perf: subscribe ONLY to the terminal records this pane's
  // terminal tabs reference (ids derived from the `tabs` prop). The old
  // whole-`state.terminals` subscription re-rendered this 1100-line bar on
  // every mutation of ANY project's terminals (git-status/cwd churn at ~1Hz
  // per active terminal across all projects); useShallow over the pane-scoped
  // array means only a changed record among this pane's own terminals (or a
  // tab add/remove) re-renders. Records keep their identity between unrelated
  // mutations (terminal-store maps the array per-event but leaves untouched
  // terminal objects as-is), so shallow compare collapses unrelated churn.
  const paneTerminalIds = useMemo(
    () => tabs.filter((t) => t.type === 'terminal').map((t) => t.terminalId),
    [tabs]
  )
  const paneTerminals: Array<Terminal | undefined> = useTerminalStore(
    useShallow((state) => paneTerminalIds.map((id) => state.terminals.find((t) => t.id === id)))
  )
  const terminalStoreTerminals = paneTerminals
  const isFullscreenPane = fullscreenPaneId === paneId

  // Close guards mirrored at the tab-bar level so menu enablement and bulk
  // target lists agree with what WorkspaceLayout's dispatch will actually
  // close — a filtered-out tab must not inflate counts or turn an enabled
  // item into a dead click.
  const editorFilePaths = useMemo(
    () => tabs.filter((t) => t.type === 'editor').map((t) => t.filePath),
    [tabs]
  )
  const busyEditorPaths = useEditorStore(
    useShallow((state) =>
      editorFilePaths.filter((path) => {
        const status = state.openFiles.get(path)?.operationStatus
        return status === 'saving' || status === 'reloading'
      })
    )
  )
  const busyEditorPathSet = useMemo(() => new Set(busyEditorPaths), [busyEditorPaths])

  const agentChatSessionIds = useMemo(
    () => tabs.filter((t) => t.type === 'agent-chat').map((t) => t.sessionId),
    [tabs]
  )
  const closingSessionFlags = useAgentChatLifetimeStore(
    useShallow((state) =>
      agentChatSessionIds.map((sessionId) => Boolean(state.closingSessionIds[sessionId]))
    )
  )
  const closingSessionIdSet = useMemo(() => {
    const set = new Set<string>()
    agentChatSessionIds.forEach((sessionId, i) => {
      if (closingSessionFlags[i]) set.add(sessionId)
    })
    return set
  }, [agentChatSessionIds, closingSessionFlags])

  // Tabs that can actually be closed right now: terminal tabs whose store
  // record is gone render `null`, terminals with a close in flight and
  // agent-chat sessions already closing must not double-close, and editors
  // mid-save/reload are skipped by the layout anyway — so all of them stay
  // out of bulk counts and target lists.
  const closableTabs = useMemo(
    () =>
      tabs.filter((tab) => {
        if (tab.type === 'terminal') {
          return (
            !closingTerminalIds.includes(tab.terminalId) &&
            paneTerminals.some(
              (terminal) => terminal !== undefined && terminal.id === tab.terminalId
            )
          )
        }
        if (tab.type === 'editor') {
          return !busyEditorPathSet.has(tab.filePath)
        }
        if (tab.type === 'agent-chat') {
          return !closingSessionIdSet.has(tab.sessionId)
        }
        return true
      }),
    [tabs, paneTerminals, closingTerminalIds, busyEditorPathSet, closingSessionIdSet]
  )

  // Single-tab close dispatcher shared by the tab close button, middle-click,
  // the menu's Close item, and the bulk fallback when `onCloseTabs` is not
  // wired (tests). Every kind routes through its normal close primitive.
  const closeWorkspaceTab = useCallback(
    (tab: WorkspaceTab): void => {
      switch (tab.type) {
        case 'terminal':
          if (onCloseTerminal) onCloseTerminal(tab.terminalId, tab.id)
          break
        case 'editor':
          handleCloseEditorTab(tab.filePath)
          break
        case 'browser':
          useBrowserSessionStore.getState().removeTab(tab.browserTabId)
          useWorkspaceStore.getState().removeTab(tab.id)
          break
        case 'git':
        case 'git-history':
          useWorkspaceStore.getState().removeTab(tab.id)
          break
        case 'agent-chat':
          requestCloseAgentChat(tab.sessionId, () => {
            useWorkspaceStore.getState().removeTab(tab.id)
          })
          break
        default: {
          // Exhaustiveness guard: a new WorkspaceTab kind must be routed above.
          const unknownTab: never = tab
          void logFrontendError({
            level: 'warn',
            source: 'WorkspaceTabBar.closeWorkspaceTab',
            message: `unhandled workspace tab kind ${JSON.stringify(unknownTab)}`
          })
        }
      }
    },
    [handleCloseEditorTab, onCloseTerminal]
  )

  // Bulk menu items delegate the exact target list to WorkspaceLayout, which
  // owns the single aggregate confirmation. Without it, fall back to the
  // per-tab close path (tests) — visible in the log rather than silent.
  const dispatchCloseTabs = useCallback(
    (targets: WorkspaceTab[]): void => {
      if (targets.length === 0) {
        void logFrontendError({
          level: 'info',
          source: 'WorkspaceTabBar.bulkClose',
          message: `bulk close dispatched with no actionable tabs in pane ${paneId}`
        })
        return
      }
      // Bulk-close boundary: every target list the layout (or the test
      // fallback) receives is logged once here.
      void logFrontendError({
        level: 'info',
        source: 'WorkspaceTabBar.bulkClose',
        message: `bulk close dispatched: ${targets.length} tab(s) in pane ${paneId}`
      })
      if (onCloseTabs) {
        onCloseTabs(targets)
        return
      }
      // Degraded path: without the layout's aggregate confirmation each tab
      // re-opens its own single-slot confirm dialog. Functional, but a wiring
      // gap — surface it so a dropped prop can't ship silently.
      void logFrontendError({
        level: 'warn',
        source: 'WorkspaceTabBar.bulkClose',
        message: `onCloseTabs not wired — per-tab close fallback for ${targets.length} tab(s) in pane ${paneId}`
      })
      for (const tab of targets) {
        closeWorkspaceTab(tab)
      }
    },
    [onCloseTabs, closeWorkspaceTab, paneId]
  )

  // Disabled flags are O(1) per tab from these counts; the target lists are
  // derived lazily inside each callback so no per-render filtering runs.
  const bulkCounts = useMemo(() => {
    const closableIds = new Set<string>()
    const kindCounts = new Map<WorkspaceTab['type'], number>()
    for (const tab of closableTabs) {
      closableIds.add(tab.id)
      kindCounts.set(tab.type, (kindCounts.get(tab.type) ?? 0) + 1)
    }
    return { closableIds, kindCounts, total: closableTabs.length }
  }, [closableTabs])

  const buildBulkMenuProps = useCallback(
    (tab: WorkspaceTab): TabBulkMenuProps => {
      // A non-closable tab (busy editor, closing terminal/chat) isn't counted
      // in closableTabs, so subtract self only when it is.
      const selfCount = bulkCounts.closableIds.has(tab.id) ? 1 : 0
      return {
        onCloseOthers: () =>
          dispatchCloseTabs(closableTabs.filter((t) => t.type === tab.type && t.id !== tab.id)),
        onCloseAll: () => dispatchCloseTabs(closableTabs.filter((t) => t.type === tab.type)),
        onCloseOtherTabs: () => dispatchCloseTabs(closableTabs.filter((t) => t.id !== tab.id)),
        onCloseAllTabs: () => dispatchCloseTabs(closableTabs),
        hasOtherTabsOfKind: (bulkCounts.kindCounts.get(tab.type) ?? 0) - selfCount > 0,
        hasOtherTabsInPane: bulkCounts.total - selfCount > 0
      }
    },
    [closableTabs, bulkCounts, dispatchCloseTabs]
  )

  // Check if this tab is being dragged
  const isTabDragging = (tabId: string): boolean =>
    dragPayload?.type === 'tab' && dragPayload.tabId === tabId

  // Check if this tab is a drop target
  const isTabDropTarget = (
    tabId: string
  ): { isTarget: boolean; position: TabReorderPosition | null } => {
    if (!reorderPreview || reorderPreview.paneId !== paneId) {
      return { isTarget: false, position: null }
    }
    if (reorderPreview.targetTabId === tabId) {
      return { isTarget: true, position: reorderPreview.position }
    }
    return { isTarget: false, position: null }
  }

  return (
    <div
      className="h-9 bg-card flex items-center"
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
    >
      <div className="relative flex items-center h-full min-w-0 flex-1 overflow-hidden">
        <div
          ref={tabsContainerRef}
          onWheel={handleWheel}
          onDragLeave={handleContainerDragLeave}
          className="overflow-x-auto scrollbar-hide flex items-center h-full min-w-0 flex-1"
        >
          <div className="flex items-center h-full min-w-max">
            {tabs.map((tab) => {
              const dragging = isTabDragging(tab.id)
              const { isTarget, position } = isTabDropTarget(tab.id)

              return (
                // `layout="position"` gives reorder commits a FLIP slide;
                // position-only so width/height never tween mid-drag.
                <motion.div
                  key={tab.id}
                  layout={reducedMotion ? false : 'position'}
                  transition={{
                    layout: { duration: 0.18, ease: EASE_OUT }
                  }}
                  className="list-none h-full"
                >
                  {tab.type === 'terminal' ? (
                    (() => {
                      const terminal = terminalStoreTerminals.find(
                        (t) => t !== undefined && t.id === tab.terminalId
                      )
                      if (!terminal) return null
                      return (
                        <TerminalTabInline
                          terminal={terminal}
                          isActive={tab.id === activeTabId}
                          isDragging={dragging}
                          isDropTarget={isTarget}
                          dropPosition={position}
                          isClosing={closingTerminalIds.includes(tab.terminalId)}
                          bulkMenu={buildBulkMenuProps(tab)}
                          onSelect={() => {
                            setActiveTab(paneId, tab.id)
                            setActivePane(paneId)
                          }}
                          onClose={() => closeWorkspaceTab(tab)}
                          onRename={(name) => {
                            if (onRenameTerminal) onRenameTerminal(tab.terminalId, name)
                          }}
                          onDragStart={(e) => handleTabDragStart(tab.id, e)}
                          onDragOver={(e) => handleTabDragOver(tab.id, e)}
                          onDragLeave={handleTabDragLeave}
                          onDrop={(e) => handleTabDrop(tab.id, e)}
                        />
                      )
                    })()
                  ) : tab.type === 'editor' ? (
                    <EditorTabWrapper
                      tab={tab as { type: 'editor'; id: string; filePath: string }}
                      isActive={tab.id === activeTabId}
                      isDragging={dragging}
                      isDropTarget={isTarget}
                      dropPosition={position}
                      bulkMenu={buildBulkMenuProps(tab)}
                      onSelect={() => {
                        setActiveTab(paneId, tab.id)
                        setActivePane(paneId)
                      }}
                      onClose={() => closeWorkspaceTab(tab)}
                      onCopyPath={() => void clipboardApi.writeText(tab.filePath)}
                      onDragStart={(e) => handleTabDragStart(tab.id, e)}
                      onDragOver={(e) => handleTabDragOver(tab.id, e)}
                      onDragLeave={handleTabDragLeave}
                      onDrop={(e) => handleTabDrop(tab.id, e)}
                    />
                  ) : tab.type === 'git' ? (
                    <GitTabInline
                      tab={tab as { type: 'git'; id: string; cwd: string }}
                      isActive={tab.id === activeTabId}
                      isDragging={dragging}
                      isDropTarget={isTarget}
                      dropPosition={position}
                      bulkMenu={buildBulkMenuProps(tab)}
                      onSelect={() => {
                        setActiveTab(paneId, tab.id)
                        setActivePane(paneId)
                      }}
                      onClose={() => closeWorkspaceTab(tab)}
                      onDragStart={(e) => handleTabDragStart(tab.id, e)}
                      onDragOver={(e) => handleTabDragOver(tab.id, e)}
                      onDragLeave={handleTabDragLeave}
                      onDrop={(e) => handleTabDrop(tab.id, e)}
                    />
                  ) : tab.type === 'git-history' ? (
                    <GitHistoryTabInline
                      tab={tab as { type: 'git-history'; id: string; cwd: string }}
                      isActive={tab.id === activeTabId}
                      isDragging={dragging}
                      isDropTarget={isTarget}
                      dropPosition={position}
                      bulkMenu={buildBulkMenuProps(tab)}
                      onSelect={() => {
                        setActiveTab(paneId, tab.id)
                        setActivePane(paneId)
                      }}
                      onClose={() => closeWorkspaceTab(tab)}
                      onDragStart={(e) => handleTabDragStart(tab.id, e)}
                      onDragOver={(e) => handleTabDragOver(tab.id, e)}
                      onDragLeave={handleTabDragLeave}
                      onDrop={(e) => handleTabDrop(tab.id, e)}
                    />
                  ) : tab.type === 'agent-chat' ? (
                    <AgentChatTabInline
                      tab={tab as { type: 'agent-chat'; id: string; sessionId: string }}
                      isActive={tab.id === activeTabId}
                      isDragging={dragging}
                      isDropTarget={isTarget}
                      dropPosition={position}
                      bulkMenu={buildBulkMenuProps(tab)}
                      onSelect={() => {
                        setActiveTab(paneId, tab.id)
                        setActivePane(paneId)
                      }}
                      onClose={() => closeWorkspaceTab(tab)}
                      onDragStart={(e) => handleTabDragStart(tab.id, e)}
                      onDragOver={(e) => handleTabDragOver(tab.id, e)}
                      onDragLeave={handleTabDragLeave}
                      onDrop={(e) => handleTabDrop(tab.id, e)}
                    />
                  ) : (
                    <BrowserTabInline
                      tab={tab as { type: 'browser'; id: string; browserTabId: string }}
                      isActive={tab.id === activeTabId}
                      isDragging={dragging}
                      isDropTarget={isTarget}
                      dropPosition={position}
                      bulkMenu={buildBulkMenuProps(tab)}
                      onSelect={() => {
                        setActiveTab(paneId, tab.id)
                        setActivePane(paneId)
                      }}
                      onClose={() => closeWorkspaceTab(tab)}
                      onDragStart={(e) => handleTabDragStart(tab.id, e)}
                      onDragOver={(e) => handleTabDragOver(tab.id, e)}
                      onDragLeave={handleTabDragLeave}
                      onDrop={(e) => handleTabDrop(tab.id, e)}
                    />
                  )}
                </motion.div>
              )
            })}
          </div>
        </div>

        {hasOverflow && (
          <div className="absolute right-0 top-0 h-full w-8 bg-gradient-to-l from-card to-transparent pointer-events-none" />
        )}
      </div>

      <div className="ml-auto flex items-center gap-1 px-2 shrink-0 h-full border-l border-border/60">
        {leafCount > 1 && (
          <button
            onClick={() => togglePaneFullscreen(paneId)}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
            title={isFullscreenPane ? 'Restore pane layout' : 'Focus pane'}
            aria-label={isFullscreenPane ? 'Restore pane layout' : 'Focus pane'}
          >
            {isFullscreenPane ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        )}
        {onAddTerminal && (
          <div ref={terminalMenuRef} className="relative flex items-center h-full">
            <button
              onClick={() => setIsTerminalMenuOpen((open) => !open)}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              title="Open terminal menu"
            >
              <TerminalIcon size={12} />
            </button>

            {isTerminalMenuOpen && (
              <div className="absolute top-full right-0 mt-1 w-44 bg-popover border border-border rounded-md shadow-lg z-50 overflow-hidden">
                <div className="px-2.5 py-1 text-2xs font-medium text-muted-foreground bg-secondary/30">
                  Terminal
                </div>
                {loading ? (
                  <div className="py-1 px-2.5 space-y-1.5">
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-6 w-full" />
                  </div>
                ) : sortedShells && sortedShells.length > 0 ? (
                  <div className="py-1">
                    {sortedShells.map((shell) => (
                      <button
                        key={shell.name}
                        onClick={() => handleSelectShell(shell)}
                        className={cn(
                          'w-full px-2.5 py-1.5 text-left text-2xs hover:bg-secondary flex items-center gap-2 leading-none',
                          shell.name === defaultShell && 'text-primary'
                        )}
                      >
                        <TerminalIcon size={11} />
                        <span className="truncate">{shell.displayName}</span>
                        {shell.name === defaultShell && (
                          <span className="ml-auto text-3xs text-muted-foreground">(default)</span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-2.5 py-1.5 text-2xs text-muted-foreground">
                    No shells detected
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {onAddBrowserTab && isTauriContext() && (
          <button
            onClick={onAddBrowserTab}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
            title="New Browser Tab"
          >
            <Globe size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
