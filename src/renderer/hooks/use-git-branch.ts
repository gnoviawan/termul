import { useEffect, useRef } from 'react'
import { useTerminalStore } from '@/stores/terminal-store'

/**
 * Hook to subscribe to git branch changes for terminals
 * Updates the terminal store with the latest git branch for each terminal
 */
export function useGitBranch(): void {
  const updateTerminalGitBranch = useTerminalStore((state) => state.updateTerminalGitBranch)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // Subscribe to git branch changed events from main process
    const cleanup = window.api.terminal.onGitBranchChanged(
      (terminalId: string, branch: string | null) => {
        updateTerminalGitBranch(terminalId, branch)
      }
    )

    cleanupRef.current = cleanup

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
        cleanupRef.current = null
      }
    }
  }, [updateTerminalGitBranch])
}
