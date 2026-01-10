import { useEffect } from 'react'
import { useTerminalStore } from '@/stores/terminal-store'

export function useExitCode(): void {
  const updateTerminalExitCode = useTerminalStore((state) => state.updateTerminalExitCode)

  useEffect(() => {
    const cleanup = window.api.terminal.onExitCodeChanged((terminalId: string, exitCode: number) => {
      updateTerminalExitCode(terminalId, exitCode)
    })

    return cleanup
  }, [updateTerminalExitCode])
}
