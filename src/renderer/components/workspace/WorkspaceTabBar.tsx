import type { ShellInfo } from '@shared/types/ipc.types'
import { AnimatePresence, useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { Maximize2, Minimize2 } from '@/components/icons'
import { WindowControls } from '@/components/shell/TopRowChrome'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import { closeAgentChat } from '@/lib/agent-chat-close'
import { clipboardApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { reportUnknownTabKind } from '@/lib/workspace-tab-kinds'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useEditorStore } from '@/stores/editor-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { editorTabId, useLeafCount, useWorkspaceStore } from '@/stores/workspace-store'
import type { Terminal } from '@/types/project'
import type { TabReorderPosition } from '@/types/workspace.types'
import { EditorTab } from './EditorTab'
import { NewTabMenu } from './NewTabMenu'
import type { TabBulkMenuProps } from './tab-context-menu'
import { AgentChatTabInline } from './tabs/agent-chat-tab'
import { BrowserTabInline } from './tabs/browser-tab'
import { CanvasTabInline } from './tabs/canvas-tab'
import { DiffTabInline } from './tabs/diff-tab'
import { GitHistoryTabInline } from './tabs/git-history-tab'
import { GitTabInline } from './tabs/git-tab'
import { TabPaneProvider } from './tabs/tab-chrome'
import { computeTabPosition, TabListItem } from './tabs/tab-list-item'
import { TerminalTabInline } from './tabs/terminal-tab'

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
  /**
   * Flagged shell only: this bar is part of the window top row. `dragRegion`
   * marks the empty space of the bar as a window drag region; `windowControls`
   * renders the window controls flush at its right end. Unset = classic bar.
   */
  topRow?: { dragRegion: boolean; windowControls: boolean }
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
  defaultShell,
  topRow
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
    handleTabReorder,
    handleDrop
  } = usePaneDnd()
  // FLIP reorder feedback — instant under prefers-reduced-motion.
  const reducedMotion = useReducedMotion() ?? false

  const dragAttr = topRow?.dragRegion ? true : undefined

  const [hasOverflow, setHasOverflow] = useState(false)
  const tabsContainerRef = useRef<HTMLDivElement>(null)

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

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (tabsContainerRef.current) {
      e.preventDefault()
      tabsContainerRef.current.scrollLeft += e.deltaY
    }
  }, [])

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

  // Tabs that can actually be closed right now: terminal tabs whose store
  // record is gone render `null`, terminals with a close in flight must not
  // double-close, and editors mid-save/reload are skipped by the layout
  // anyway — so all of them stay out of bulk counts and target lists.
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
        return true
      }),
    [tabs, paneTerminals, closingTerminalIds, busyEditorPathSet]
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
        case 'diff':
          useWorkspaceStore.getState().removeTab(tab.id)
          break
        case 'agent-chat':
          closeAgentChat(tab.sessionId, () => {
            useWorkspaceStore.getState().removeTab(tab.id)
          })
          break
        case 'canvas':
          // Canvas disposal: the daemon is evicted (stdin EOF → kill) and the
          // MCP entry stays persisted; daemon lifetime = canvas lifetime —
          // this is the ONLY canvas teardown path (tab switches never kill).
          void useCanvasStore.getState().closeCanvas(tab.projectId)
          useWorkspaceStore.getState().removeTab(tab.id)
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
    <TabPaneProvider paneId={paneId}>
      <div
        className="flex h-10 items-center bg-card"
        data-tauri-drag-region={dragAttr}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(e) => {
          // Only chat drags land on the bar itself; tab and file drops keep
          // their existing handling.
          if (dragPayload?.type !== 'chat') return
          e.preventDefault()
          e.stopPropagation()
          handleDrop(paneId, 'center', e)
        }}
      >
        <div
          className="relative flex items-center h-full min-w-0 flex-1 overflow-hidden"
          data-tauri-drag-region={dragAttr}
        >
          <div
            ref={tabsContainerRef}
            data-tauri-drag-region={dragAttr}
            onWheel={handleWheel}
            onDragLeave={handleContainerDragLeave}
            className="overflow-x-auto scrollbar-hide flex items-center h-full min-w-0 flex-1"
          >
            <div
              role="tablist"
              className="flex h-full min-w-max items-center gap-0.5 px-1"
              data-tauri-drag-region={dragAttr}
            >
              {/* Tab mount/unmount motion: arrivals (center drops, opened
                files, new terminals) grow width 0→auto with a fade,
                departures shrink back — the same push feel as a pane grow.
                `initial={false}` keeps pane remounts (project restore,
                fullscreen toggle) from mass-animating restored tabs. */}
              <AnimatePresence initial={false}>
                {tabs.map((tab) => {
                  const dragging = isTabDragging(tab.id)
                  const { isTarget, position } = isTabDropTarget(tab.id)

                  return (
                    <TabListItem key={tab.id} reducedMotion={reducedMotion}>
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
                        <EditorTab
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
                      ) : tab.type === 'diff' ? (
                        <DiffTabInline
                          tab={tab}
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
                      ) : tab.type === 'canvas' ? (
                        <CanvasTabInline
                          tab={
                            tab as {
                              type: 'canvas'
                              id: string
                              projectId: string
                              docPath: string
                            }
                          }
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
                      ) : tab.type === 'browser' ? (
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
                      ) : (
                        (() => {
                          reportUnknownTabKind(tab, 'WorkspaceTabBar', 'rendered nothing')
                          return null
                        })()
                      )}
                    </TabListItem>
                  )
                })}
              </AnimatePresence>
            </div>
          </div>

          {hasOverflow && (
            <div className="absolute right-0 top-0 h-full w-8 bg-gradient-to-l from-card to-transparent pointer-events-none" />
          )}
        </div>

        <div
          className="ml-auto flex h-full shrink-0 items-center gap-1 px-2"
          data-tauri-drag-region={dragAttr}
        >
          <span aria-hidden className="mr-1 h-5 w-px shrink-0 bg-border/60" />
          {leafCount > 1 && (
            <button
              onClick={() => togglePaneFullscreen(paneId)}
              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors duration-150 ease-out"
              title={isFullscreenPane ? 'Restore pane layout' : 'Focus pane'}
              aria-label={isFullscreenPane ? 'Restore pane layout' : 'Focus pane'}
            >
              {isFullscreenPane ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </button>
          )}
          {/* One `+` New tab menu covers terminals and browser tabs. */}
          <NewTabMenu
            paneId={paneId}
            onAddTerminal={onAddTerminal}
            onAddBrowserTab={onAddBrowserTab}
            defaultShell={defaultShell}
          />
        </div>

        {topRow?.windowControls && <WindowControls windowControls />}
      </div>
    </TabPaneProvider>
  )
}
