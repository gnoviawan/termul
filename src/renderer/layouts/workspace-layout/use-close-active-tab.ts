import { useCallback, useEffect, useRef } from 'react'
import { listen, type UnlistenFn } from '@/lib/tauri-event'
import { closeWorkspaceTab } from '@/lib/workspace-tab-close'
import type { WorkspaceTab } from '@/stores/workspace-store'

interface UseCloseActiveTabOptions {
  activeTab: WorkspaceTab | undefined
  isAgentLauncherOpen: boolean
  closeEditorTab: (filePath: string) => boolean
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
  closeEditorTab
}: UseCloseActiveTabOptions) {
  // Ref for terminal close handler — used inside keydown effect to avoid
  // declaration-order dependency. The ref is updated each render.
  const handleCloseTerminalRef = useRef<((id: string, tabId: string) => void) | null>(null)

  /** Close the active tab (reused by keyboard shortcut and native menu event). */
  const closeActiveTab = useCallback(() => {
    if (!activeTab || activeTab.type === 'canvas') return
    closeWorkspaceTab(
      activeTab,
      {
        terminal: (tab) => {
          handleCloseTerminalRef.current?.(tab.terminalId, tab.id)
          return false
        },
        editor: (tab) => closeEditorTab(tab.filePath)
      },
      'WorkspaceLayout.closeActiveTab'
    )
  }, [activeTab, closeEditorTab])

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
