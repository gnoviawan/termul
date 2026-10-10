import { useCallback, useEffect, useRef } from 'react'
import { requestCloseAgentChat } from '@/hooks/use-agent-idle-shutdown'
import { listen, type UnlistenFn } from '@/lib/tauri-event'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useEditorStore } from '@/stores/editor-store'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'

interface UseCloseActiveTabOptions {
  activeTab: WorkspaceTab | undefined
  isAgentLauncherOpen: boolean
  setDirtyCloseFilePath: (filePath: string | null) => void
}

/**
 * Closes the active workspace tab for the keyboard shortcut and the native
 * `menu:close-tab` event. Returns `handleCloseTerminalRef`, which the terminal
 * close hook assigns so the terminal branch can call it without a
 * declaration-order dependency.
 */
export function useCloseActiveTab({
  activeTab,
  isAgentLauncherOpen,
  setDirtyCloseFilePath
}: UseCloseActiveTabOptions) {
  // Ref for terminal close handler — used inside keydown effect to avoid
  // declaration-order dependency. The ref is updated each render.
  const handleCloseTerminalRef = useRef<((id: string, tabId: string) => void) | null>(null)

  /** Close the active tab (reused by keyboard shortcut and native menu event). */
  const closeActiveTab = useCallback(() => {
    if (!activeTab) return
    if (activeTab.type === 'editor') {
      const fileState = useEditorStore.getState().openFiles.get(activeTab.filePath)
      if (fileState?.isDirty) {
        setDirtyCloseFilePath(activeTab.filePath)
      } else {
        const didClose = useEditorStore.getState().closeFileIfIdle(activeTab.filePath)
        if (didClose) {
          useWorkspaceStore.getState().removeTab(activeTab.id)
        }
      }
    } else if (activeTab.type === 'git' || activeTab.type === 'git-history') {
      useWorkspaceStore.getState().removeTab(activeTab.id)
    } else if (activeTab.type === 'terminal') {
      handleCloseTerminalRef.current?.(activeTab.terminalId, activeTab.id)
    } else if (activeTab.type === 'browser') {
      useBrowserSessionStore.getState().removeTab(activeTab.browserTabId)
      useWorkspaceStore.getState().removeTab(activeTab.id)
    } else if (activeTab.type === 'agent-chat') {
      requestCloseAgentChat(activeTab.sessionId, () => {
        useWorkspaceStore.getState().removeTab(activeTab.id)
      })
    }
  }, [activeTab, setDirtyCloseFilePath])

  // Listen for native menu "Close Tab" event (macOS Cmd+W intercepted by menu bar)
  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    listen<void>('menu:close-tab', () => {
      // Skip when Agent Launcher is open to avoid accidental tab closure
      if (!isAgentLauncherOpen) {
        closeActiveTab()
      }
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {
        // Not in Tauri context — ignore
      })
    return () => {
      unlisten?.()
    }
  }, [closeActiveTab, isAgentLauncherOpen])

  return { closeActiveTab, handleCloseTerminalRef }
}
