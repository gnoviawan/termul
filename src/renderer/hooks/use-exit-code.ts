import { useEffect } from 'react'
import { terminalApi } from '@/lib/api'
import { useTerminalStore } from '@/stores/terminal-store'
import { disposeExitCodeBuffer, exitCodeBuffer } from './exit-code-buffer'

export function useExitCode(): void {
  useEffect(() => {
    const store = useTerminalStore
    exitCodeBuffer.connect(
      (ptyId) => store.getState().findTerminalByPtyId(ptyId),
      (id, exitCode) => store.getState().updateTerminalExitCode(id, exitCode),
      (listener) => store.subscribe(listener)
    )
    const stop = terminalApi.onExitCodeChanged((ptyId: string, exitCode: number) => {
      exitCodeBuffer.handle(ptyId, exitCode)
    })
    return () => {
      stop()
      disposeExitCodeBuffer()
    }
  }, [])
}
