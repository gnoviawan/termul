import { useEffect, useRef } from 'react'
import { useTerminalStore } from '@/stores/terminal-store'
import type { GitStatus } from '@/types/project'

/**
 * Hook to subscribe to git status changes for terminals
 * Updates the terminal store with the latest git status for each terminal
 */
export function useGitStatus(): void {
  const updateTerminalGitStatus = useTerminalStore((state) => state.updateTerminalGitStatus)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // Subscribe to git status changed events from main process
    const cleanup = window.api.terminal.onGitStatusChanged(
      (terminalId: string, status: GitStatus | null) => {
        updateTerminalGitStatus(terminalId, status)
      }
    )

    cleanupRef.current = cleanup

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
        cleanupRef.current = null
      }
    }
  }, [updateTerminalGitStatus])
}
