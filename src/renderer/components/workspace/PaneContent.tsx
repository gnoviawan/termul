import type { DetectedShells, ShellInfo } from '@shared/types/ipc.types'
import { Terminal as TerminalIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
// Import useShallow for selective re-rendering
import { useShallow } from 'zustand/shallow'
import { BrowserPanel } from '@/components/browser/BrowserPanel'
import { EditorPanel } from '@/components/editor/EditorPanel'
import { GitHistoryPanel } from '@/components/git/GitHistoryPanel'
import { GitPanel } from '@/components/git/GitPanel'
import { ConnectedTerminal } from '@/components/terminal/ConnectedTerminal'
import { Button } from '@/components/ui/button'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import { shellApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalActions, useTerminalStore } from '@/stores/terminal-store'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import type { LeafNode } from '@/types/workspace.types'
import { DropZoneOverlay } from './DropZoneOverlay'
import { WorkspaceTabBar } from './WorkspaceTabBar'

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
  const _paneId = pane.id

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
  const { activePaneId, fullscreenPaneId, setActivePane } = useWorkspaceStore(
    useShallow((state) => ({
      activePaneId: state.activePaneId,
      fullscreenPaneId: state.fullscreenPaneId,
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

  const [shells, setShells] = useState<DetectedShells | null>(null)

  useEffect(() => {
    const fetchShells = async (): Promise<void> => {
      try {
        const result = await shellApi.getAvailableShells()
        if (result.success) {
          setShells(result.data)
        }
      } catch {
        setShells(null)
      }
    }
    void fetchShells()
  }, [])

  const sortedShells = useMemo(() => {
    return shells?.available?.slice().sort((a, b) => {
      if (defaultShell) {
        if (a.name === defaultShell) return -1
        if (b.name === defaultShell) return 1
      }
      return a.displayName.localeCompare(b.displayName)
    })
  }, [shells, defaultShell])

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
              .map((tab, _index) => {
                const terminal = terminalsInPane.find((t) => t.id === tab.terminalId)
                if (!terminal) {
                  return null
                }
                // CRITICAL: Skip rendering if terminal doesn't have a PTY ID yet
                // This prevents spawn loops when workspace tabs aren't fully synced
                if (!terminal.ptyId) {
                  const isVisible = activeTab?.id === tab.id
                  return (
                    <div
                      key={tab.id}
                      className={
                        isVisible
                          ? 'w-full h-full flex items-center justify-center text-muted-foreground text-sm'
                          : 'hidden'
                      }
                    >
                      Connecting...
                    </div>
                  )
                }
                const isVisible = activeTab?.id === tab.id
                const connectedTerminalSpawnOptions = {
                  projectId: terminal.projectId,
                  shell: terminal.shell,
                  cwd: terminal.cwd
                }
                return (
                  <div
                    key={tab.id}
                    className={cn(
                      isVisible ? 'w-full h-full' : 'w-full h-full absolute inset-0 invisible',
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
                    className={
                      isVisible ? 'w-full h-full' : 'w-full h-full absolute inset-0 invisible'
                    }
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
                    className={
                      isVisible ? 'w-full h-full' : 'w-full h-full absolute inset-0 invisible'
                    }
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
                    className={
                      isVisible ? 'w-full h-full' : 'w-full h-full absolute inset-0 invisible'
                    }
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
                    className={
                      isVisible ? 'w-full h-full' : 'w-full h-full absolute inset-0 invisible'
                    }
                  >
                    <GitHistoryPanel cwd={tab.cwd} isVisible={isVisible} />
                  </div>
                )
              })}

            {pane.tabs.length === 0 ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-8">
                <div className="flex flex-col items-center gap-2 text-center">
                  <span className="text-muted-foreground text-sm font-medium">
                    Drag a tab or file here
                  </span>
                  <span className="text-muted-foreground/50 text-xs">
                    or open a new terminal or tab
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-2 max-w-md">
                  {sortedShells?.map((shell) => (
                    <Button
                      key={shell.name}
                      variant="outline"
                      size="sm"
                      className="h-8 text-[11px] gap-2"
                      onClick={() => onAddTerminal?.(pane.id, shell)}
                    >
                      <TerminalIcon size={12} />
                      {shell.displayName}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {isDragging && !isFullscreenPane && <DropZoneOverlay paneId={pane.id} />}
      </div>
    </div>
  )
}
