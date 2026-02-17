import { useEffect, useRef } from 'react'
import { useTerminalStore } from '@/stores/terminal-store'
import type { GitStatus } from '@/types/project'

/**
 * Hook to subscribe to git status changes for terminals
 * Updates the terminal store with the latest git status for each terminal
 */
export function useGitStatus(): void {
  const updateTerminalGitStatus = useTerminalStore((state) => state.updateTerminalGitStatus)
  const findTerminalByPtyId = useTerminalStore((state) => state.findTerminalByPtyId)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // Subscribe to git status changed events from main process
    const cleanup = window.api.terminal.onGitStatusChanged(
      (ptyId: string, status: GitStatus | null) => {
        // Look up terminal by ptyId and update using store id
        const terminal = findTerminalByPtyId(ptyId)
        if (terminal) {
          updateTerminalGitStatus(terminal.id, status)
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
  }, [updateTerminalGitStatus, findTerminalByPtyId])
}
