import { useEffect, useRef } from 'react'
import { useTerminalStore } from '@/stores/terminal-store'

/**
 * Hook to subscribe to git branch changes for terminals
 * Updates the terminal store with the latest git branch for each terminal
 */
export function useGitBranch(): void {
  const updateTerminalGitBranch = useTerminalStore((state) => state.updateTerminalGitBranch)
  const findTerminalByPtyId = useTerminalStore((state) => state.findTerminalByPtyId)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // Subscribe to git branch changed events from main process
    const cleanup = window.api.terminal.onGitBranchChanged(
      (ptyId: string, branch: string | null) => {
        // Look up terminal by ptyId and update using store id
        const terminal = findTerminalByPtyId(ptyId)
        if (terminal) {
          updateTerminalGitBranch(terminal.id, branch)
        }
      }
    )

    cleanupRef.current = cleanup

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
        cleanupRef.current = null
      }
    }
  }, [updateTerminalGitBranch, findTerminalByPtyId])
}
