import type { MutableRefObject } from 'react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useUpdateAppSetting } from '@/hooks/use-app-settings'
import { terminalApi } from '@/lib/api'
import { useConfirmTerminalClose } from '@/stores/app-settings-store'
import { useTerminalActions, useTerminalStore } from '@/stores/terminal-store'
import { findPaneContainingTab, useWorkspaceStore } from '@/stores/workspace-store'

interface UseTerminalCloseOptions {
  activeProjectId: string
  /** Assigned each render so `closeActiveTab` can reach `handleCloseTerminal`. */
  handleCloseTerminalRef: MutableRefObject<((id: string, tabId: string) => void) | null>
}

/** Terminal tab close flow: PTY kill, confirm dialog and "don't ask again". */
export function useTerminalClose({
  activeProjectId,
  handleCloseTerminalRef
}: UseTerminalCloseOptions) {
  const confirmTerminalClose = useConfirmTerminalClose()
  const { closeTerminal } = useTerminalActions()
  const updateAppSetting = useUpdateAppSetting()
  const [closeConfirmTerminal, setCloseConfirmTerminal] = useState<{
    terminalId: string
    tabId: string
  } | null>(null)
  const [closeConfirmLoading, setCloseConfirmLoading] = useState(false)
  const [closeConfirmRememberChoice, setCloseConfirmRememberChoice] = useState(false)
  const [closingTerminalIds, setClosingTerminalIds] = useState<string[]>([])

  const closeTerminalByRecordId = useCallback(
    async (terminalRecordId: string): Promise<boolean> => {
      const terminalToClose = useTerminalStore
        .getState()
        .terminals.find((t) => t.id === terminalRecordId)

      if (!terminalToClose) {
        return false
      }

      if (closingTerminalIds.includes(terminalRecordId)) {
        return false
      }

      setClosingTerminalIds((current) => [...current, terminalRecordId])

      try {
        if (terminalToClose.ptyId) {
          const result = await terminalApi.kill(terminalToClose.ptyId)
          if (!result.success) {
            console.error('Failed to close terminal PTY:', result.error)
            toast.error(result.error || 'Failed to close terminal process. Please try again.')
            return false
          }
        }

        closeTerminal(terminalRecordId, activeProjectId)
        return true
      } finally {
        setClosingTerminalIds((current) => current.filter((id) => id !== terminalRecordId))
      }
    },
    [activeProjectId, closeTerminal, closingTerminalIds]
  )

  const closeTerminalTabByTabId = useCallback(
    async (tabId: string): Promise<boolean> => {
      const root = useWorkspaceStore.getState().root
      const containingPane = findPaneContainingTab(root, tabId)
      if (!containingPane) {
        return false
      }

      const tab = containingPane.tabs.find((t) => t.id === tabId)
      if (tab?.type !== 'terminal') {
        return false
      }

      const didClose = await closeTerminalByRecordId(tab.terminalId)
      if (!didClose) {
        return false
      }
      useWorkspaceStore.getState().closeTab(containingPane.id, tabId)
      return true
    },
    [closeTerminalByRecordId]
  )

  // Returns true only when it opened the close confirm, so a caller that sits
  // under that dialog (the mobile drawer) knows to get out of its way. Closing
  // at once, or refusing a terminal that is already closing, returns false.
  const handleCloseTerminal = useCallback(
    (id: string, tabId: string): boolean => {
      if (closingTerminalIds.includes(id)) {
        return false
      }

      if (!confirmTerminalClose) {
        void closeTerminalTabByTabId(tabId)
        return false
      }

      setCloseConfirmRememberChoice(false)
      setCloseConfirmTerminal({ terminalId: id, tabId })
      return true
    },
    [closeTerminalTabByTabId, closingTerminalIds, confirmTerminalClose]
  )

  // Keep ref in sync so the keydown effect can call it without declaration-order issues
  handleCloseTerminalRef.current = handleCloseTerminal

  const handleConfirmCloseTerminal = useCallback(async () => {
    if (!closeConfirmTerminal) {
      return
    }

    setCloseConfirmLoading(true)
    try {
      if (closeConfirmRememberChoice) {
        await updateAppSetting('confirmTerminalClose', false)
      }

      const didClose = await closeTerminalTabByTabId(closeConfirmTerminal.tabId)
      if (didClose) {
        setCloseConfirmTerminal(null)
        setCloseConfirmRememberChoice(false)
      }
    } finally {
      setCloseConfirmLoading(false)
    }
  }, [closeConfirmRememberChoice, closeConfirmTerminal, closeTerminalTabByTabId, updateAppSetting])

  const handleCancelCloseTerminal = useCallback(() => {
    if (closeConfirmLoading) {
      return
    }

    setCloseConfirmRememberChoice(false)
    setCloseConfirmTerminal(null)
  }, [closeConfirmLoading])

  return {
    closeConfirmTerminal,
    closeConfirmLoading,
    closeConfirmRememberChoice,
    setCloseConfirmRememberChoice,
    closingTerminalIds,
    closeTerminalTabByTabId,
    handleCloseTerminal,
    handleConfirmCloseTerminal,
    handleCancelCloseTerminal
  }
}
