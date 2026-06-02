import type { ShellInfo } from '@shared/types/ipc.types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
// Import useShallow for selective re-rendering
import { useShallow } from 'zustand/shallow'
import { AgentIcon } from '@/components/agents/AgentIcon'
import { AgentLauncher } from '@/components/agents/AgentLauncher'
import { BrowserPanel } from '@/components/browser/BrowserPanel'
import { EditorPanel } from '@/components/editor/EditorPanel'
import { GitHistoryPanel } from '@/components/git/GitHistoryPanel'
import { GitPanel } from '@/components/git/GitPanel'
import { ConnectedTerminal } from '@/components/terminal/ConnectedTerminal'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalActions, useTerminalStore } from '@/stores/terminal-store'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import type { LeafNode } from '@/types/workspace.types'
import { DropZoneOverlay } from './DropZoneOverlay'
import { WorkspaceTabBar } from './WorkspaceTabBar'

/** Inactive tabs stay mounted but must not intercept clicks on the active tab beneath. */
const INACTIVE_TAB_PANE_CLASS = 'w-full h-full absolute inset-0 invisible pointer-events-none'

interface PaneContentProps {
  pane: LeafNode
  onAddTerminal?: (paneId: string, shell?: ShellInfo) => void
  onAddBrowserTab?: (paneId: string) => void
  onCloseTerminal?: (id: string, tabId: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  closingTerminalIds?: string[]
  defaultShell?: string
}

export function PaneContent({
  pane,
  onAddTerminal,
  onAddBrowserTab,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  closingTerminalIds = [],
  defaultShell
}: PaneContentProps): React.JSX.Element {
  // CRITICAL FIX: Get terminal IDs from this pane's tabs
  const terminalIdsInPane = useMemo(
    () => new Set(pane.tabs.filter((t) => t.type === 'terminal').map((t) => t.terminalId)),
    [pane.tabs]
  )

  // CRITICAL FIX: Only subscribe to terminals' essential properties (not output!)
  // and ENSURE we only show terminals belonging to the active project to prevent "leaks"
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const terminalsInPane = useTerminalStore(
    useShallow((state) =>
      state.terminals.filter((t) => terminalIdsInPane.has(t.id) && t.projectId === activeProjectId)
    )
  )

  // FIX: Batch workspace store subscriptions with useShallow to prevent cascading re-renders
  const { activePaneId, fullscreenPaneId, agentLauncherPaneId, setActivePane } = useWorkspaceStore(
    useShallow((state) => ({
      activePaneId: state.activePaneId,
      fullscreenPaneId: state.fullscreenPaneId,
      agentLauncherPaneId: state.agentLauncherPaneId,
      setActivePane: state.setActivePane
    }))
  )

  const hasMultiplePanes = useWorkspaceStore((state) => getAllLeafPanes(state.root).length > 1)

  const { setTerminalPtyId } = useTerminalActions()
  const { isDragging, previewTarget } = usePaneDnd()

  const isFullscreenPane = fullscreenPaneId === pane.id
  const isActivePane = activePaneId === pane.id
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId)
  const activeTerminalIdInPane = activeTab?.type === 'terminal' ? activeTab.terminalId : null
  const panePreviewPosition =
    previewTarget?.paneId === pane.id && !isFullscreenPane ? previewTarget.position : null

  // Agent loading: show pulsing icon for a minimum duration after the terminal
  // is first seen. The xterm renderer attaches almost instantly (same frame),
  // so rendererAttachmentCount alone isn't enough for a visible loading state.
  const [agentLoadingIds, setAgentLoadingIds] = useState<Set<string>>(new Set())
  const agentLoadingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const prevAgentTerminalIdsRef = useRef<string[]>([])
  const AGENT_LOADING_MS = 1500

  // Detect newly appeared agent terminals and start loading timers.
  // This runs after every render where terminalsInPane changes (useShallow).
  useEffect(() => {
    const currentIds = terminalsInPane
      .filter((t) => t.kind === 'agent' && t.agentId && t.ptyId)
      .map((t) => t.id)
    const prevIds = prevAgentTerminalIdsRef.current
    prevAgentTerminalIdsRef.current = currentIds

    for (const id of currentIds) {
      if (!prevIds.includes(id) && !agentLoadingTimers.current.has(id)) {
        // New agent terminal — add to loading set with a minimum duration.
        setAgentLoadingIds((prev) => new Set(prev).add(id))
        agentLoadingTimers.current.set(
          id,
          setTimeout(() => {
            setAgentLoadingIds((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
            agentLoadingTimers.current.delete(id)
          }, AGENT_LOADING_MS)
        )
      }
    }
  }, [terminalsInPane])

  const handleFocus = useCallback(() => {
    if (!isActivePane) {
      setActivePane(pane.id)
    }
    // Clicking into the pane is an explicit acknowledgment of its visible terminal:
    // clear the finished-terminal highlight. This is the ONLY clear path — we do not
    // auto-clear on tab-switch or remount, so a flagged background tab keeps its border
    // until the user actually looks at it.
    if (activeTerminalIdInPane) {
      const store = useTerminalStore.getState()
      const term = store.terminals.find((t) => t.id === activeTerminalIdInPane)
      if (term?.needsAttention) {
        store.setTerminalNeedsAttention(activeTerminalIdInPane, false)
      }
    }
  }, [isActivePane, setActivePane, pane.id, activeTerminalIdInPane])

  // Keyboard parity for the mouse acknowledgment above: a keystroke directed at this
  // pane's visible terminal is an explicit "I'm looking at it" signal, so clear the
  // highlight. Capture phase + a real key event means this never fires on a passive
  // tab-switch (which only auto-focuses the terminal, no keypress), avoiding the
  // flash-and-vanish that auto-clear-on-visibility caused.
  const handleKeyDownCapture = useCallback(() => {
    if (!activeTerminalIdInPane) return
    const store = useTerminalStore.getState()
    const term = store.terminals.find((t) => t.id === activeTerminalIdInPane)
    if (term?.needsAttention) {
      store.setTerminalNeedsAttention(activeTerminalIdInPane, false)
    }
  }, [activeTerminalIdInPane])

  const previewSpaceClass =
    panePreviewPosition === 'left'
      ? 'pl-6'
      : panePreviewPosition === 'right'
        ? 'pr-6'
        : panePreviewPosition === 'top'
          ? 'pt-6'
          : panePreviewPosition === 'bottom'
            ? 'pb-6'
            : ''

  const previewTranslateClass =
    panePreviewPosition === 'left'
      ? 'translate-x-2'
      : panePreviewPosition === 'right'
        ? '-translate-x-2'
        : panePreviewPosition === 'top'
          ? 'translate-y-2'
          : panePreviewPosition === 'bottom'
            ? '-translate-y-2'
            : ''

  return (
    <div
      className={cn(
        'flex flex-col h-full relative',
        isActivePane && hasMultiplePanes && !isFullscreenPane && 'ring-1 ring-primary/30',
        isFullscreenPane && 'ring-1 ring-primary/30 rounded-xl overflow-hidden'
      )}
      onMouseDown={handleFocus}
      onKeyDownCapture={handleKeyDownCapture}
    >
      <WorkspaceTabBar
        paneId={pane.id}
        tabs={pane.tabs}
        activeTabId={pane.activeTabId}
        closingTerminalIds={closingTerminalIds}
        onAddTerminal={useMemo(
          () => (onAddTerminal ? (shell?: ShellInfo) => onAddTerminal(pane.id, shell) : undefined),
          [onAddTerminal, pane.id]
        )}
        onAddBrowserTab={useMemo(
          () => (onAddBrowserTab ? () => onAddBrowserTab(pane.id) : undefined),
          [onAddBrowserTab, pane.id]
        )}
        onCloseTerminal={onCloseTerminal}
        onRenameTerminal={onRenameTerminal}
        onCloseEditorTab={onCloseEditorTab}
        defaultShell={defaultShell}
      />

      <div className="flex-1 overflow-hidden bg-terminal-bg relative h-full">
        <div
          className={cn(
            'w-full h-full relative transition-all duration-150 ease-out',
            previewSpaceClass
          )}
        >
          {(panePreviewPosition === 'left' || panePreviewPosition === 'right') && (
            <div
              className={cn(
                'absolute top-0 bottom-0 w-5 rounded-sm border border-primary/40 bg-primary/10 pointer-events-none',
                panePreviewPosition === 'left' ? 'left-0' : 'right-0'
              )}
            />
          )}
          {(panePreviewPosition === 'top' || panePreviewPosition === 'bottom') && (
            <div
              className={cn(
                'absolute left-0 right-0 h-5 rounded-sm border border-primary/40 bg-primary/10 pointer-events-none',
                panePreviewPosition === 'top' ? 'top-0' : 'bottom-0'
              )}
            />
          )}

          <div
            className={cn(
              'w-full h-full relative transition-transform duration-150 ease-out',
              previewTranslateClass
            )}
          >
            {pane.tabs
              .filter((t): t is WorkspaceTab & { type: 'terminal' } => t.type === 'terminal')
              .map((tab) => {
                const terminal = terminalsInPane.find((t) => t.id === tab.terminalId)
                if (!terminal) {
                  return null
                }
                // CRITICAL: Only skip rendering if terminal doesn't have a PTY
                // ID yet — this prevents spawn loops when workspace tabs aren't
                // fully synced. For agent terminals with a ptyId, ConnectedTerminal
                // MUST mount so it can attach the renderer (which sets
                // rendererAttachmentCount to 1). Instead of blocking the mount,
                // we overlay the agent loading icon on top until the renderer
                // attaches — see the overlay div after ConnectedTerminal.
                if (!terminal.ptyId) {
                  const isVisible = activeTab?.id === tab.id
                  const isAgent = terminal.kind === 'agent' && !!terminal.agentId
                  return (
                    <div
                      key={tab.id}
                      className={
                        isVisible
                          ? 'w-full h-full flex flex-col items-center justify-center gap-3'
                          : 'hidden'
                      }
                    >
                      {isAgent ? (
                        <>
                          <span className="animate-pulse motion-reduce:animate-none">
                            <AgentIcon agentId={terminal.agentId!} className="h-16 w-16" />
                          </span>
                          <span className="text-sm text-muted-foreground">
                            Starting {terminal.agentName ?? terminal.name}…
                          </span>
                        </>
                      ) : (
                        <span className="text-sm text-muted-foreground">Connecting…</span>
                      )}
                    </div>
                  )
                }
                const isVisible = activeTab?.id === tab.id
                const isAgentLoading =
                  terminal.kind === 'agent' &&
                  !!terminal.agentId &&
                  agentLoadingIds.has(terminal.id)
                const connectedTerminalSpawnOptions = {
                  projectId: terminal.projectId,
                  shell: terminal.shell,
                  cwd: terminal.cwd
                }
                return (
                  <div
                    key={tab.id}
                    className={cn(
                      isVisible ? 'w-full h-full' : INACTIVE_TAB_PANE_CLASS,
                      // In-app highlight: ring the whole terminal content when its
                      // process finished while unfocused. Distinct amber accent,
                      // inset so it stays inside the pane and clear of the
                      // active-pane primary ring and drop overlays. Pulse is
                      // disabled under prefers-reduced-motion.
                      terminal.needsAttention &&
                        'rounded-sm ring-2 ring-inset ring-amber-400/70 animate-pulse motion-reduce:animate-none'
                    )}
                  >
                    <ConnectedTerminal
                      terminalId={terminal.ptyId}
                      storeTerminalId={terminal.id}
                      autoSpawn={false}
                      spawnOptions={connectedTerminalSpawnOptions}
                      onBoundToStoreTerminal={(ptyId) => {
                        if (terminal.ptyId !== ptyId) {
                          setTerminalPtyId(terminal.id, ptyId)
                        }
                      }}
                      initialScrollback={terminal.pendingScrollback}
                      className="w-full h-full"
                      isVisible={isVisible}
                    />
                    {/* Agent loading overlay: shown until ConnectedTerminal attaches
											the renderer (rendererAttachmentCount flips to 1). Covers the
											xterm div with a centered pulsing icon so the user sees feedback. */}
                    {isAgentLoading && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/95">
                        <span className="animate-pulse motion-reduce:animate-none">
                          <AgentIcon
                            agentId={terminal.agentId!}
                            name={terminal.agentName}
                            className="h-16 w-16"
                          />
                        </span>
                        <span className="text-sm text-muted-foreground">
                          Starting {terminal.agentName ?? terminal.name}…
                        </span>
                      </div>
                    )}
                  </div>
                )
              })}

            {pane.tabs
              .filter((t): t is WorkspaceTab & { type: 'editor' } => t.type === 'editor')
              .map((tab) => {
                const isVisible = activeTab?.id === tab.id
                return (
                  <div
                    key={tab.id}
                    className={isVisible ? 'w-full h-full' : INACTIVE_TAB_PANE_CLASS}
                  >
                    <EditorPanel filePath={tab.filePath} isVisible={isVisible} />
                  </div>
                )
              })}

            {pane.tabs
              .filter((t): t is WorkspaceTab & { type: 'browser' } => t.type === 'browser')
              .map((tab) => {
                const isVisible = activeTab?.id === tab.id
                return (
                  <div
                    key={tab.id}
                    className={isVisible ? 'w-full h-full' : INACTIVE_TAB_PANE_CLASS}
                  >
                    <BrowserPanel browserTabId={tab.browserTabId} isVisible={isVisible} />
                  </div>
                )
              })}

            {pane.tabs
              .filter((t): t is WorkspaceTab & { type: 'git' } => t.type === 'git')
              .map((tab) => {
                const isVisible = activeTab?.id === tab.id
                return (
                  <div
                    key={tab.id}
                    className={isVisible ? 'w-full h-full' : INACTIVE_TAB_PANE_CLASS}
                  >
                    <GitPanel cwd={tab.cwd} isVisible={isVisible} />
                  </div>
                )
              })}

            {pane.tabs
              .filter((t): t is WorkspaceTab & { type: 'git-history' } => t.type === 'git-history')
              .map((tab) => {
                const isVisible = activeTab?.id === tab.id
                return (
                  <div
                    key={tab.id}
                    className={isVisible ? 'w-full h-full' : INACTIVE_TAB_PANE_CLASS}
                  >
                    <GitHistoryPanel cwd={tab.cwd} isVisible={isVisible} />
                  </div>
                )
              })}

            {pane.tabs.length === 0 ? (
              <div className="absolute inset-0">
                {/* ADR-004.5: agent launch + plain terminal picker */}
                <AgentLauncher paneId={pane.id} />
              </div>
            ) : null}
          </div>
        </div>

        {isDragging && !isFullscreenPane && <DropZoneOverlay paneId={pane.id} />}
      </div>

      {/* ADR-004.5 overlay: pane-level so Ctrl+T covers tab bar + content. */}
      {agentLauncherPaneId === pane.id && pane.tabs.length > 0 ? (
        <div
          className="absolute inset-0 z-30 flex flex-col bg-background/95 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Agent launcher"
          onKeyDown={(e) => {
            if (e.key === 'Escape') useWorkspaceStore.getState().hideAgentLauncher()
          }}
        >
          <AgentLauncher paneId={pane.id} />
        </div>
      ) : null}
    </div>
  )
}
