import { useEffect } from 'react'
import { useTerminalStore } from '@/stores/terminal-store'

export function useExitCode(): void {
  const updateTerminalExitCode = useTerminalStore((state) => state.updateTerminalExitCode)
  const findTerminalByPtyId = useTerminalStore((state) => state.findTerminalByPtyId)

  useEffect(() => {
    const cleanup = window.api.terminal.onExitCodeChanged((ptyId: string, exitCode: number) => {
      // Look up terminal by ptyId and update using store id
      const terminal = findTerminalByPtyId(ptyId)
      if (terminal) {
        updateTerminalExitCode(terminal.id, exitCode)
      }
    })

    return cleanup
  }, [updateTerminalExitCode, findTerminalByPtyId])
}
