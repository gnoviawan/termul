import type { TerminalsWatchState, WsTerminalSetEntry } from '@shared/types/web-protocol.types'
import { useEffect, useState } from 'react'
import { getAcpTransport } from '@/lib/acp-transport'

const NO_TERMINALS: WsTerminalSetEntry[] = []

/**
 * The terminals a project has on the host, including detached ones, from the
 * host `terminals` watch. Every state or delta replaces the set; a reconnect or
 * a lost delta makes the watch client rebuild it from fresh state. Always empty
 * on desktop, which has no host watch, and while the host has not answered yet.
 * It carries no claim credentials: `list_preserved` still hands out claims.
 */
export function useWebTerminalSet(projectId: string | null | undefined): WsTerminalSetEntry[] {
  const [terminals, setTerminals] = useState<WsTerminalSetEntry[]>(NO_TERMINALS)

  useEffect(() => {
    setTerminals(NO_TERMINALS)
    const watches = getAcpTransport().watches
    if (!projectId || !watches) return
    const replace = (set: TerminalsWatchState): void =>
      setTerminals(Array.isArray(set?.terminals) ? set.terminals : NO_TERMINALS)
    return watches.subscribe<TerminalsWatchState, TerminalsWatchState>(
      'terminals',
      { onState: replace, onDelta: replace },
      projectId
    )
  }, [projectId])

  return terminals
}
