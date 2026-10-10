import { useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import { useUpdateAppSetting, useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { getShortcutTargetContext } from '@/layouts/workspace-layout/shortcut-target'
import { keyboardApi } from '@/lib/api'
import { isSaveFileShortcut, requestSaveEditorFile } from '@/lib/editor-save'
import { isTauriContext } from '@/lib/tauri-runtime'
import { getWebAuthGateState } from '@/lib/web-auth-gate'
import { useUiZoomLevel } from '@/stores/app-settings-store'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import { matchesShortcut } from '@/stores/keyboard-shortcuts-store'
import { useSidebarVisible } from '@/stores/sidebar-store'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { UI_ZOOM_DEFAULT, UI_ZOOM_MAX, UI_ZOOM_MIN, UI_ZOOM_STEP } from '@/types/settings'

interface UseWorkspaceKeyboardOptions {
  activeTab: WorkspaceTab | undefined
  activeProjectId: string
  projects: Project[]
  selectProject: (id: string) => void
  isWorkspaceRoute: boolean
  isAgentLauncherOpen: boolean
  closeActiveTab: () => void
  getActiveKey: (id: string) => string
  handleNewBrowserTab: (paneId?: string) => void
  handleOpenThemePicker: () => void
  setIsCommandPaletteOpen: (open: boolean) => void
  setIsCommandHistoryOpen: (open: boolean) => void
  setIsNewProjectModalOpen: (open: boolean) => void
}

/** Workspace keyboard shortcuts: save capture, the global keydown handler and backend shortcut callbacks. */
export function useWorkspaceKeyboard({
  activeTab,
  activeProjectId,
  projects,
  selectProject,
  isWorkspaceRoute,
  isAgentLauncherOpen,
  closeActiveTab,
  getActiveKey,
  handleNewBrowserTab,
  handleOpenThemePicker,
  setIsCommandPaletteOpen,
  setIsCommandHistoryOpen,
  setIsNewProjectModalOpen
}: UseWorkspaceKeyboardOptions): void {
  const isExplorerVisible = useFileExplorerVisible()
  const isSidebarVisible = useSidebarVisible()
  const uiZoomLevel = useUiZoomLevel()
  const updateAppSetting = useUpdateAppSetting()
  const updatePanelVisibility = useUpdatePanelVisibility()

  // Shared whole-UI zoom action used by both the DOM keydown path and the
  // keyboardApi.onShortcut callback so behavior stays identical.
  const applyZoomAction = useCallback(
    (action: 'zoomIn' | 'zoomOut' | 'zoomReset'): void => {
      const next =
        action === 'zoomIn'
          ? Math.min(uiZoomLevel + UI_ZOOM_STEP, UI_ZOOM_MAX)
          : action === 'zoomOut'
            ? Math.max(uiZoomLevel - UI_ZOOM_STEP, UI_ZOOM_MIN)
            : UI_ZOOM_DEFAULT
      if (next !== uiZoomLevel) updateAppSetting('uiZoomLevel', next)
    },
    [uiZoomLevel, updateAppSetting]
  )

  // Unified tab cycling - cycles through ALL workspace tabs in active pane
  const cycleTab = useCallback(
    (direction: 'next' | 'prev') => {
      if (!isWorkspaceRoute) return
      const store = useWorkspaceStore.getState()
      const nextTabId = store.getNextTabId(direction === 'next' ? 1 : -1)
      if (nextTabId) {
        store.setActiveTab(store.activePaneId, nextTabId)
      }
    },
    [isWorkspaceRoute]
  )

  // Capture-phase save so WebView/editors cannot block Ctrl+S before it
  // reaches us. #907: while the web auth gate has the workspace swapped for
  // the token screen, the (hidden) workspace's save shortcut must stay
  // inert — typing Ctrl+S in the token field must never save the hidden
  // active editor.
  useEffect(() => {
    const handleSaveShortcut = (e: KeyboardEvent): void => {
      // Live gate state via the accessor — the guard stays correct without
      // re-registering the listener on every gate transition.
      if (getWebAuthGateState().status === 'unauthorized') return
      if (!isSaveFileShortcut(e)) return
      e.preventDefault()
      e.stopPropagation()
      const path =
        activeTab?.type === 'editor' ? activeTab.filePath : useEditorStore.getState().activeFilePath
      if (path) {
        void requestSaveEditorFile(path)
      }
    }

    window.addEventListener('keydown', handleSaveShortcut, { capture: true })
    return () => window.removeEventListener('keydown', handleSaveShortcut, { capture: true })
  }, [activeTab])

  // biome-ignore lint/correctness/useExhaustiveDependencies: handler reads latest values via closure; deps intentionally narrow
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isSaveFileShortcut(e)) return
      // #907: workspace shortcuts stay inert while the token screen owns
      // the surface (same guard as the capture-phase save handler above).
      // Read via the non-React accessor so the guard sees the LIVE gate
      // state without widening this effect's deps (CI contention).
      if (getWebAuthGateState().status === 'unauthorized') return

      // Safety net: skip workspace handling when an earlier handler has already
      // processed this event by calling preventDefault() — e.g. xterm clipboard
      // ops or ConnectedTerminal's customKeyEventHandler for terminal-owned keys.
      if (e.defaultPrevented) return

      const { isInEditor, isInTerminal, isInInput } = getShortcutTargetContext(e.target)

      // Close Tab (Ctrl+W / ⌘+W)
      // On macOS: ⌘+W closes tab, Ctrl+W is forwarded to shell (backward-kill-word)
      // On Windows/Linux: Ctrl+W closes tab
      // Always preventDefault to suppress OS/webview close behavior; only
      // close the tab when the Agent Launcher is not open.
      if (matchesShortcut(e, getActiveKey('closeTab'))) {
        e.preventDefault()
        if (!isAgentLauncherOpen) {
          closeActiveTab()
        }
        return
      }

      // Toggle File Explorer (Ctrl+B / ⌘+B) — skip when in editor/input/terminal
      if (matchesShortcut(e, getActiveKey('toggleFileExplorer'))) {
        if (!isInEditor && !isInInput && !isInTerminal) {
          e.preventDefault()
          void updatePanelVisibility('fileExplorerVisible', !isExplorerVisible).catch((error) => {
            toast.error(
              error instanceof Error ? error.message : 'Failed to update file explorer visibility'
            )
          })
        }
        return
      }

      if (matchesShortcut(e, getActiveKey('sidebarToggle'))) {
        if (!isInEditor && !isInInput) {
          e.preventDefault()
          e.stopPropagation()
          void updatePanelVisibility('sidebarVisible', !isSidebarVisible).catch((error) => {
            toast.error(
              error instanceof Error ? error.message : 'Failed to update sidebar visibility'
            )
          })
        }
        return
      }

      // ── Global shortcuts — work from any focus context ────────────────
      // These must be checked before the isInInput/isInEditor guard.
      // They open overlays or perform workspace actions that should be
      // reachable while typing in the editor, browser, or terminal.

      // Command palette (Ctrl+K / Ctrl+Shift+P)
      if (
        matchesShortcut(e, getActiveKey('commandPalette')) ||
        matchesShortcut(e, getActiveKey('commandPaletteAlt'))
      ) {
        e.preventDefault()
        e.stopPropagation()
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        setIsCommandPaletteOpen(true)
        return
      }

      // Command history (Ctrl+R)
      if (matchesShortcut(e, getActiveKey('commandHistory'))) {
        e.preventDefault()
        e.stopPropagation()
        if (activeProjectId) {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur()
          }
          setIsCommandHistoryOpen(true)
        }
        return
      }

      // Color theme picker (Ctrl+Alt+T)
      if (matchesShortcut(e, getActiveKey('colorThemePicker'))) {
        e.preventDefault()
        e.stopPropagation()
        handleOpenThemePicker()
        return
      }

      // New project (Ctrl+N)
      if (matchesShortcut(e, getActiveKey('newProject'))) {
        e.preventDefault()
        e.stopPropagation()
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        setIsNewProjectModalOpen(true)
        return
      }

      // Ctrl+T: show the agent launcher prompt overlay in the active pane.
      // The launcher is an overlay — existing tabs are preserved underneath.
      // When the agent is launched, a new tab is added to the same pane.
      if (matchesShortcut(e, getActiveKey('newTerminal'))) {
        if (!isWorkspaceRoute) return
        e.preventDefault()
        e.stopPropagation()
        const paneId = useWorkspaceStore.getState().activePaneId
        if (paneId) {
          const current = useWorkspaceStore.getState().agentLauncherPaneId
          // Toggle: if already showing on this pane, hide it; otherwise show it.
          if (current === paneId) {
            useWorkspaceStore.getState().hideAgentLauncher()
          } else {
            useWorkspaceStore.getState().showAgentLauncher(paneId)
          }
        }
        return
      }

      // New browser tab (Ctrl+Shift+N) - workspace only, desktop only.
      // Story 8 (web honesty): browser tabs are native child webviews — the
      // web client cannot create them, so the shortcut must no-op there
      // instead of adding a tab whose pane renders blank (rejected
      // browserTabCreate).
      if (matchesShortcut(e, getActiveKey('newBrowserTab'))) {
        if (!isWorkspaceRoute || !isTauriContext()) return
        e.preventDefault()
        e.stopPropagation()
        handleNewBrowserTab()
        return
      }

      // Tab cycling (Ctrl+PageDown / Ctrl+PageUp)
      if (matchesShortcut(e, getActiveKey('nextTerminal'))) {
        e.preventDefault()
        e.stopPropagation()
        cycleTab('next')
        return
      }
      if (matchesShortcut(e, getActiveKey('prevTerminal'))) {
        e.preventDefault()
        e.stopPropagation()
        cycleTab('prev')
        return
      }

      // Zoom in/out/reset — whole-UI zoom (VS Code style)
      if (matchesShortcut(e, getActiveKey('zoomIn'))) {
        e.preventDefault()
        e.stopPropagation()
        applyZoomAction('zoomIn')
        return
      }
      if (matchesShortcut(e, getActiveKey('zoomOut'))) {
        e.preventDefault()
        e.stopPropagation()
        applyZoomAction('zoomOut')
        return
      }
      if (matchesShortcut(e, getActiveKey('zoomReset'))) {
        e.preventDefault()
        e.stopPropagation()
        applyZoomAction('zoomReset')
        return
      }

      // Cmd/Ctrl + 1-9 for project switching
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const index = parseInt(e.key, 10) - 1
        if (projects[index]) selectProject(projects[index].id)
        return
      }

      // ── Below this: only runs when NOT in input/editor ────────────────
      // Terminal search (Ctrl+F) - handled at pane level
      if (matchesShortcut(e, getActiveKey('terminalSearch'))) {
        if (isWorkspaceRoute) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    projects,
    selectProject,
    activeProjectId,
    getActiveKey,
    applyZoomAction,
    isWorkspaceRoute,
    cycleTab,
    activeTab,
    handleNewBrowserTab,
    updatePanelVisibility,
    isExplorerVisible,
    isSidebarVisible,
    handleOpenThemePicker,
    closeActiveTab,
    isAgentLauncherOpen
  ])

  // Listen for optional backend shortcut callbacks. In current Tauri fallback mode this is effectively a future-compat shim.
  useEffect(() => {
    return keyboardApi.onShortcut((shortcut) => {
      switch (shortcut) {
        case 'nextTerminal':
          cycleTab('next')
          break
        case 'prevTerminal':
          cycleTab('prev')
          break
        case 'zoomIn':
          applyZoomAction('zoomIn')
          break
        case 'zoomOut':
          applyZoomAction('zoomOut')
          break
        case 'zoomReset':
          applyZoomAction('zoomReset')
          break
        case 'sidebarToggle':
          void updatePanelVisibility('sidebarVisible', !isSidebarVisible).catch((error) => {
            toast.error(
              error instanceof Error ? error.message : 'Failed to update sidebar visibility'
            )
          })
          break
        case 'colorThemePicker':
          handleOpenThemePicker()
          break
      }
    })
  }, [cycleTab, applyZoomAction, handleOpenThemePicker, updatePanelVisibility, isSidebarVisible])
}
