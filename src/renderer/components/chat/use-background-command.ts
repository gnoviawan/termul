import type { BackgroundCommand } from '@/lib/acp-api'
import { useAcpStore } from '@/stores/acp-store'
import { sessionBackgroundCommands } from './background-commands'
import { useSubagentSurface } from './subagent-surface-context'

export function useBackgroundCommand(toolCallId: string): BackgroundCommand | undefined {
  const { sessionId } = useSubagentSurface()
  return useAcpStore((s) =>
    sessionId
      ? sessionBackgroundCommands(s.sessions[sessionId]).find(
          (command) => command.toolCallId === toolCallId
        )
      : undefined
  )
}
