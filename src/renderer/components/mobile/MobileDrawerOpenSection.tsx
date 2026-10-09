import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/shallow'
import { ChatEntryIcon } from '@/components/chat/ChatHistoryEntryRow'
import {
  Edit2,
  GitBranch,
  Globe,
  History,
  Pencil,
  Plus,
  TerminalSquare,
  X
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  AgentChatStatusGlyphs,
  agentChatStatusSlots,
  useAgentChatStatusSignals
} from '@/components/workspace/tabs/agent-chat-status'
import { requestCloseAgentChat } from '@/hooks/use-agent-idle-shutdown'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { returnToWorkspaceRoute } from '@/lib/workspace-route'
import { useAcpStore } from '@/stores/acp-store'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useEditorStore } from '@/stores/editor-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { getAllLeafPanes, useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'

/** Inline row actions (close, rename, new terminal) hold the 44px touch floor. */
const INLINE_ACTION_BUTTON = 'size-11 shrink-0'

/**
 * Row select button: 44px minimum, a leading bar that is `primary` on the
 * active row (a non-colour-only cue beside the `secondary` fill) and
 * transparent otherwise so every row keeps the same text inset.
 */
function rowButtonClass(isActive: boolean): string {
  return cn(
    'h-auto min-h-11 flex-1 justify-start gap-2 border-l-2 px-2 py-1.5 text-sm',
    isActive ? 'border-l-primary' : 'border-l-transparent'
  )
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

/** Which Open group a row belongs to: each has its own "next row, else heading" focus rule. */
type RowGroup = 'chats' | 'terminals' | 'tabs'

/**
 * Where focus goes once the control the user pressed is gone (L-18). A closed
 * row takes its X with it, and a rename input takes itself, so without this
 * focus falls to `<body>` inside the drawer's focus trap. Registered before the
 * action, resolved in a layout effect once the row (or the input) is gone.
 */
type PendingFocus =
  | { kind: 'removal'; group: RowGroup; rowId: string; nextRowId: string | null }
  | { kind: 'rename'; terminalId: string }

/** True when focus has fallen to `<body>` (or to something no longer attached). */
function focusIsLost(): boolean {
  const active = document.activeElement
  return !active || active === document.body || !active.isConnected
}

/** Focus the first candidate that really takes it (a hidden or non-focusable one does not). */
function focusFirst(candidates: Array<HTMLElement | null | undefined>): boolean {
  for (const element of candidates) {
    if (!element?.isConnected) continue
    element.focus()
    if (document.activeElement === element) return true
  }
  return false
}

/** The `[attribute]` element of `root` whose attribute value is exactly `value`. */
function findByDataValue(
  root: HTMLElement | null,
  attribute: string,
  value: string
): HTMLElement | null {
  const matches = root?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? []
  return Array.from(matches).find((element) => element.getAttribute(attribute) === value) ?? null
}

/** Every tab the Tabs group lists: all but terminals and chats, which have their own groups. */
type OtherTab = Exclude<WorkspaceTab, { type: 'terminal' } | { type: 'agent-chat' }>

/** A Tabs row's label (also the name of its close button). */
function otherTabLabel(tab: OtherTab, browserLabel: (browserTabId: string) => string): string {
  switch (tab.type) {
    case 'editor':
      return basename(tab.filePath) || 'editor tab'
    case 'git':
      return 'Git Changes'
    case 'git-history':
      return 'Git History'
    case 'browser':
      return browserLabel(tab.browserTabId)
    case 'canvas':
      return basename(tab.docPath)
    default: {
      // Exhaustiveness guard (as in WorkspaceTabBar): a new WorkspaceTab kind
      // fails to compile here instead of rendering a blank row.
      const unhandledTab: never = tab
      void unhandledTab
      return 'Tab'
    }
  }
}

interface MobileDrawerOpenSectionProps {
  /** The active pane's active tab id: that row is `aria-current="page"`. */
  activeTabId: string | null
  /** Id of the drawer's "Open" heading, which labels the chat group. */
  openHeadingId: string
  /** A row navigated: the drawer closes (and moves focus to the destination). */
  onNavigate: () => void
  onNewTerminal?: () => void
  /** Returns `true` only when the close opened a confirm (see `onConfirmOpened`). */
  onCloseTerminal?: (terminalId: string, tabId: string) => boolean
  onRenameTerminal?: (terminalId: string, name: string) => void
  /**
   * Close an editor tab through the dirty-file guard (WorkspaceLayout
   * `handleCloseEditorTab` semantics) so drawer closes never silently
   * discard unsaved changes. Returns `true` only when it opened the confirm.
   */
  onCloseEditorTab?: (filePath: string) => boolean
  /**
   * `onCloseTerminal` or `onCloseEditorTab` opened a confirm (they return
   * `true` only then). The drawer hands off to it: it closes, so the confirm is
   * not covered by the drawer's overlay.
   */
  onConfirmOpened?: () => void
}

interface OpenChatRowProps {
  tab: { id: string; sessionId: string }
  isActive: boolean
  onSelect: () => void
  onClose: () => void
}

/**
 * One open agent chat. The status signals come from the same hook as the
 * desktop `agent-chat-tab`; "New activity" comes from the renderer-only unread
 * store (the drawer is unmounted while closed, so a row cannot track it).
 * Open rows never show Failed: there is no source signal for one.
 */
function OpenChatRow({ tab, isActive, onSelect, onClose }: OpenChatRowProps): React.JSX.Element {
  const signals = useAgentChatStatusSignals(tab.sessionId)
  const unread = useAgentChatUnreadStore((state) => Boolean(state.unread[tab.sessionId]))
  const { showWorking, showUnread, statuses, statusText } = agentChatStatusSlots({
    ...signals,
    unread
  })
  // Label: live session title -> index entry title -> 'Agent Chat'. The index
  // entry also carries the agent config the glyph resolves through. One
  // shallow-compared selector so a row re-renders only when these change.
  const { title, indexAgentId, agentConfigId } = useAcpStore(
    useShallow((s) => {
      const entry = (s.sessionIndex ?? []).find((e) => e.id === tab.sessionId)
      return {
        title: s.sessions?.[tab.sessionId]?.title || entry?.title || 'Agent Chat',
        indexAgentId: entry?.agentId,
        agentConfigId: entry?.agentConfigId
      }
    })
  )

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant={isActive ? 'secondary' : 'ghost'}
        className={rowButtonClass(isActive)}
        aria-current={isActive ? 'page' : undefined}
        aria-label={statusText ? `${title}, ${statusText}` : title}
        data-open-row-select={tab.id}
        onClick={onSelect}
      >
        <span className="flex min-w-3.5 shrink-0 items-center gap-1">
          <AgentChatStatusGlyphs
            closing={signals.closing}
            needsAttention={signals.needsAttention}
            showWorking={showWorking}
            showUnread={showUnread}
          />
        </span>
        <ChatEntryIcon
          agentId={signals.session?.agentId ?? indexAgentId}
          agentConfigId={agentConfigId}
        />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {statuses.map((status) => (
          <span
            key={status}
            className={cn(
              'shrink-0 text-2xs',
              status === 'Needs you' ? 'text-warning' : 'text-muted-foreground'
            )}
          >
            {status}
          </span>
        ))}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={INLINE_ACTION_BUTTON}
        aria-label={`Close ${title}`}
        onClick={onClose}
      >
        <X size={14} />
      </Button>
    </div>
  )
}

/**
 * The drawer's "Open" body: open chats first (with live status), then
 * Terminals, then the remaining tabs. On mobile the WorkspaceTabBar is hidden
 * (PaneContent gates it on `isMobileWebShell`), so without these rows every
 * tab would be a one-way dead end; each close routes through the same
 * teardown path the hidden tab bar would use.
 */
export function MobileDrawerOpenSection({
  activeTabId,
  openHeadingId,
  onNavigate,
  onNewTerminal,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  onConfirmOpened
}: MobileDrawerOpenSectionProps): React.JSX.Element {
  const terminalsHeadingId = useId()
  const tabsHeadingId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const pendingFocusRef = useRef<PendingFocus | null>(null)
  // Set when a rename ends; the input's own blur (fired when it unmounts) must
  // not commit a second time, nor undo an Escape.
  const renameEndedRef = useRef(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const navigate = useNavigate()
  const { pathname } = useLocation()

  // ALL pane tabs across every leaf (terminal, editor, git, git-history,
  // browser, agent-chat, canvas). Derive via useMemo from the stable `root`
  // reference so the wrapper objects are only rebuilt when the tree changes.
  const workspaceRoot = useWorkspaceStore((s) => s.root)
  const paneTabs = useMemo(() => {
    const leaves = getAllLeafPanes(workspaceRoot)
    return leaves.flatMap((leaf) => (leaf.tabs ?? []).map((t) => ({ tab: t, paneId: leaf.id })))
  }, [workspaceRoot])

  const chatTabs = useMemo(
    () =>
      paneTabs.flatMap(({ tab, paneId }) => (tab.type === 'agent-chat' ? [{ tab, paneId }] : [])),
    [paneTabs]
  )

  // Terminal rows keep their rename affordance; other tabs render a plain row.
  const terminalTabs = useMemo(
    () => paneTabs.flatMap(({ tab, paneId }) => (tab.type === 'terminal' ? [{ tab, paneId }] : [])),
    [paneTabs]
  )

  // Non-terminal, non-chat tabs are the QA F3 trap: they render in the drawer
  // with a close button routed through the correct teardown path.
  const otherTabs = useMemo(
    () =>
      paneTabs.flatMap(({ tab, paneId }) =>
        tab.type === 'terminal' || tab.type === 'agent-chat' ? [] : [{ tab, paneId }]
      ),
    [paneTabs]
  )

  const terminals = useTerminalStore((s) => s.terminals)

  // Editor dirty state for the dirty dots. Subscribe to the whole openFiles map
  // reference (stable unless a file opens/closes) and resolve dirtiness
  // per-row — zustand's set() always produces a new Map, so this re-renders
  // exactly when openFiles changes.
  const openFiles = useEditorStore((s) => s.openFiles)
  const isEditorFileDirty = (filePath: string): boolean => openFiles.get(filePath)?.isDirty ?? false

  // Canvas dirty state, the same way: one canvas session per project, so a row
  // resolves its own by project id.
  const canvasSessions = useCanvasStore((s) => s.sessions)
  const isCanvasDirty = (projectId: string): boolean => canvasSessions[projectId]?.dirty ?? false

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

  const groupRowIds = (group: RowGroup): string[] =>
    (group === 'chats' ? chatTabs : group === 'terminals' ? terminalTabs : otherTabs).map(
      ({ tab }) => tab.id
    )
  const groupHeadingId = (group: RowGroup): string =>
    group === 'chats' ? openHeadingId : group === 'terminals' ? terminalsHeadingId : tabsHeadingId

  // L-18: after a row is gone (or a rename ends) focus would fall to <body>
  // inside the drawer's focus trap. Mirrors the History delete rule: the next
  // row's select button in the same group, else that group's heading, else this
  // section's root, which stays mounted and programmatically focusable. Only
  // when focus really was lost: a user who moved focus meanwhile keeps it, and a
  // close that has not completed (a chat still Closing, a kill that failed)
  // leaves the row, and focus, alone.
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current
    if (!pending) return
    if (pending.kind === 'removal') {
      if (groupRowIds(pending.group).includes(pending.rowId)) return
    } else if (renamingId === pending.terminalId) {
      return
    }
    pendingFocusRef.current = null
    if (!focusIsLost()) return
    const root = rootRef.current
    const candidates =
      pending.kind === 'rename'
        ? [findByDataValue(root, 'data-open-rename', pending.terminalId)]
        : [
            pending.nextRowId
              ? findByDataValue(root, 'data-open-row-select', pending.nextRowId)
              : null,
            document.getElementById(groupHeadingId(pending.group)),
            root
          ]
    if (!focusFirst(candidates)) {
      void logFrontendError({
        level: 'info',
        source: 'MobileDrawerOpenSection.focus',
        message: `Open row ${pending.kind === 'rename' ? 'rename ended' : 'closed'} with no connected focus target`
      })
    }
  })

  const registerRemovalFocus = (group: RowGroup, rowId: string): void => {
    const ids = groupRowIds(group)
    const index = ids.indexOf(rowId)
    pendingFocusRef.current = {
      kind: 'removal',
      group,
      rowId,
      nextRowId: (index >= 0 ? ids[index + 1] : undefined) ?? null
    }
  }

  // Select any pane tab from a drawer row (generalized selectTerminal) and
  // close the drawer. Agent-chat selection routes through setActiveTab which
  // also navigates to the chat session.
  const selectTab = (paneId: string, tabId: string): void => {
    const workspace = useWorkspaceStore.getState()
    // Drawer rows are the tab chooser on /snapshots (no picker of its own).
    // Off the workspace route (the same test WorkspaceLayout uses to decide
    // whether to mount the panes) a non-chat tab has no route of its own, so
    // return to the workspace once the tab is active. Chat rows already land
    // on /c/<id> through setActiveTab.
    const selectedType = paneTabs.find(({ tab }) => tab.id === tabId)?.tab.type
    const isChatRow = selectedType === 'agent-chat'
    const activate = (): void => {
      const current = useWorkspaceStore.getState()
      // Fullscreen pins activePaneId to its own leaf (resolveActivePaneId), so
      // a tab chosen in any other leaf would update that leaf's active tab yet
      // leave the mobile view on the fullscreen one (a dead tap). Fullscreen is
      // per-client view state, so leave it (existing store action) when the row
      // belongs to a different leaf; a row in the fullscreen leaf keeps it.
      if (current.fullscreenPaneId && current.fullscreenPaneId !== paneId) {
        current.clearFullscreenPane()
      }
      current.setActiveTab(paneId, tabId)
      if (!isChatRow) returnToWorkspaceRoute(pathname, navigate)
    }
    if (workspace.activePaneId !== paneId) {
      // Defer tab activation until pane is active. The return navigation
      // follows the activation inside the same frame callback, so the
      // workspace route never paints the previously active leaf first.
      requestAnimationFrame(activate)
    } else {
      activate()
    }
    onNavigate()
  }

  // Close routing per tab type — mirror of the (hidden) WorkspaceTabBar
  // close semantics so the drawer never silently bypasses a guard:
  //   editor → dirty guard (threaded from WorkspaceLayout)
  //   terminal → existing confirm flow (threaded as onCloseTerminal)
  //   browser → session-tab teardown + tab removal
  //   canvas → daemon eviction (closeCanvas) + tab removal
  //   git / git-history / agent-chat → plain removeTab
  // The editor and terminal guards report whether they opened a confirm; then
  // the drawer hands off to it instead of staying open underneath.
  const closePaneTab = (tab: WorkspaceTab, group: RowGroup): void => {
    registerRemovalFocus(group, tab.id)
    const handedOffToConfirm = (): void => {
      // The drawer closes under the confirm: nothing left here to focus.
      pendingFocusRef.current = null
      onConfirmOpened?.()
    }
    if (tab.type === 'editor') {
      if (onCloseEditorTab) {
        if (onCloseEditorTab(tab.filePath)) handedOffToConfirm()
      } else {
        // No guard threaded: fall back to direct close (still not silent
        // data loss in practice — the editor auto-save policy owns unsaved
        // content; the guard path is the wired default).
        useWorkspaceStore.getState().removeTab(tab.id)
      }
      return
    }
    if (tab.type === 'terminal') {
      if (onCloseTerminal?.(tab.terminalId, tab.id)) handedOffToConfirm()
      return
    }
    if (tab.type === 'browser') {
      useBrowserSessionStore.getState().removeTab(tab.browserTabId)
      useWorkspaceStore.getState().removeTab(tab.id)
      return
    }
    if (tab.type === 'agent-chat') {
      requestCloseAgentChat(tab.sessionId, () => {
        useWorkspaceStore.getState().removeTab(tab.id)
      })
      return
    }
    if (tab.type === 'canvas') {
      // Canvas disposal, as the desktop tab bar does it: the daemon is evicted
      // (daemon lifetime = canvas lifetime) and this is the only teardown path.
      void useCanvasStore.getState().closeCanvas(tab.projectId)
      useWorkspaceStore.getState().removeTab(tab.id)
      return
    }
    useWorkspaceStore.getState().removeTab(tab.id)
  }

  const startRename = (terminalId: string, currentName: string): void => {
    renameEndedRef.current = false
    setRenamingId(terminalId)
    setRenameValue(currentName)
  }

  // Enter and Escape end a rename on purpose, so focus returns to that row's
  // Rename button; a blur (the user moved on) commits without moving focus.
  const endRename = (outcome: 'commit' | 'cancel', focus: 'rename-button' | 'leave'): void => {
    if (renameEndedRef.current) return
    renameEndedRef.current = true
    if (focus === 'rename-button' && renamingId) {
      pendingFocusRef.current = { kind: 'rename', terminalId: renamingId }
    }
    if (outcome === 'commit' && renamingId && renameValue.trim() && onRenameTerminal) {
      onRenameTerminal(renamingId, renameValue.trim())
    }
    setRenamingId(null)
    setRenameValue('')
  }

  return (
    <div ref={rootRef} tabIndex={-1} className="px-1 pb-2 outline-none">
      {chatTabs.length > 0 && (
        <div role="group" aria-labelledby={openHeadingId} className="flex flex-col gap-0.5">
          {chatTabs.map(({ tab, paneId }) => (
            <OpenChatRow
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onSelect={() => selectTab(paneId, tab.id)}
              onClose={() => closePaneTab(tab, 'chats')}
            />
          ))}
        </div>
      )}

      <div className="mt-1">
        <div className="flex items-center justify-between pl-2">
          <h3
            id={terminalsHeadingId}
            tabIndex={-1}
            className="label-group text-muted-foreground outline-none"
          >
            Terminals
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={INLINE_ACTION_BUTTON}
            aria-label="New terminal"
            onClick={() => {
              onNavigate()
              onNewTerminal?.()
            }}
          >
            <Plus size={16} />
          </Button>
        </div>
        {terminalTabs.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No open terminals</p>
        ) : (
          <div role="group" aria-labelledby={terminalsHeadingId} className="flex flex-col gap-0.5">
            {terminalTabs.map(({ tab, paneId }) => {
              const terminalName = terminals.find((item) => item.id === tab.terminalId)?.name
              const name = terminalName ?? 'terminal'
              const isActive = tab.id === activeTabId
              const isRenaming = renamingId === tab.terminalId
              return (
                <div key={tab.id} className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant={isActive ? 'secondary' : 'ghost'}
                    className={rowButtonClass(isActive)}
                    aria-current={isActive ? 'page' : undefined}
                    data-open-row-select={tab.id}
                    onClick={() => selectTab(paneId, tab.id)}
                  >
                    <TerminalSquare size={16} />
                    <span className="min-w-0 flex-1 truncate">{terminalName ?? 'Terminal'}</span>
                  </Button>
                  {isRenaming ? (
                    <input
                      type="text"
                      value={renameValue}
                      aria-label={`Rename ${name}`}
                      data-open-rename-input=""
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => endRename('commit', 'leave')}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== 'Escape') return
                        // Focus moves to the Rename button inside this very
                        // keydown. Left alone, the browser then fires the key's
                        // keypress on that button, and Enter on a button clicks
                        // it: the field would reopen as soon as it closed.
                        // Cancelling the keydown suppresses the keypress.
                        e.preventDefault()
                        endRename(e.key === 'Enter' ? 'commit' : 'cancel', 'rename-button')
                      }}
                      className="min-h-11 w-28 rounded border border-border bg-background px-2 text-base"
                      autoFocus
                    />
                  ) : (
                    onRenameTerminal && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={INLINE_ACTION_BUTTON}
                        aria-label={`Rename ${name}`}
                        data-open-rename={tab.terminalId}
                        onClick={() => startRename(tab.terminalId, terminalName ?? 'Terminal')}
                      >
                        <Pencil size={14} />
                      </Button>
                    )
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={INLINE_ACTION_BUTTON}
                    aria-label={`Close ${name}`}
                    onClick={() => closePaneTab(tab, 'terminals')}
                  >
                    <X size={14} />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {otherTabs.length > 0 && (
        <div className="mt-1">
          <h3
            id={tabsHeadingId}
            tabIndex={-1}
            className="label-group py-1 pl-2 text-muted-foreground outline-none"
          >
            Tabs
          </h3>
          <div role="group" aria-labelledby={tabsHeadingId} className="flex flex-col gap-0.5">
            {otherTabs.map(({ tab, paneId }) => {
              const isActive = tab.id === activeTabId
              const rowLabel = otherTabLabel(tab, browserLabel)
              return (
                <div key={tab.id} className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant={isActive ? 'secondary' : 'ghost'}
                    className={rowButtonClass(isActive)}
                    aria-current={isActive ? 'page' : undefined}
                    data-open-row-select={tab.id}
                    onClick={() => selectTab(paneId, tab.id)}
                  >
                    {tab.type === 'editor' && <Pencil size={16} />}
                    {tab.type === 'git' && <GitBranch size={16} />}
                    {tab.type === 'git-history' && <History size={16} />}
                    {tab.type === 'browser' && <Globe size={16} />}
                    {tab.type === 'canvas' && <Edit2 size={16} />}
                    <span className="min-w-0 flex-1 truncate">{rowLabel}</span>
                    {tab.type === 'editor' && isEditorFileDirty(tab.filePath) && (
                      <>
                        <span
                          data-testid="editor-dirty-dot"
                          aria-hidden="true"
                          className="ml-1 size-1.5 shrink-0 rounded-full bg-primary-fill"
                        />
                        <span className="sr-only">, unsaved changes</span>
                      </>
                    )}
                    {tab.type === 'canvas' && isCanvasDirty(tab.projectId) && (
                      <>
                        <span
                          data-testid="canvas-dirty-dot"
                          aria-hidden="true"
                          className="ml-1 size-1.5 shrink-0 rounded-full bg-primary-fill"
                        />
                        <span className="sr-only">, unsaved changes</span>
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={INLINE_ACTION_BUTTON}
                    aria-label={`Close ${rowLabel}`}
                    onClick={() => closePaneTab(tab, 'tabs')}
                  >
                    <X size={14} />
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
