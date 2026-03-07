import { useTerminalStore } from '@/stores/terminal-store'

export function hasActiveTerminalSessions(): boolean {
  const terminals = useTerminalStore.getState().terminals

  return terminals.some((terminal) => {
    if (terminal.healthStatus === 'hibernated') return false
    return terminal.isHidden !== true
  })
}
