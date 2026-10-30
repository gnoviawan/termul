import { useTerminalStore } from '@/stores/terminal-store'
import { sessionStore } from './session-store'
import type { InputMode, SessionPhase } from './transition'

export interface PtyInputGuardState {
  mode: InputMode
  phase?: SessionPhase
}

/**
 * Shared guard deciding whether terminal input may be written to the PTY.
 * - `mode === 'Editor'` -> drop (`false`)
 * - trusted `phase === 'Submitting'` -> drop (`false`), EXCEPT `'\x03'`
 * - raw / untrusted / anything else, including a stale Submitting phase -> allow
 */
export function canWriteToPty(state: PtyInputGuardState, data: string): boolean {
  if (state.mode === 'Editor') return false
  if (state.mode === 'PTY' && state.phase === 'Submitting') return data === '\x03'
  return true
}

export function resolveLifecycleTerminalId(
  terminalId: string | null | undefined
): string | null | undefined {
  if (!terminalId) return terminalId
  const store = useTerminalStore.getState()
  if (store.terminals.some((terminal) => terminal.id === terminalId)) return terminalId
  return store.findTerminalByPtyId(terminalId)?.id ?? terminalId
}

export function canTerminalWriteToPty(
  terminalId: string | null | undefined,
  data: string,
  modeFallback?: InputMode
): boolean {
  if (modeFallback === 'Editor') return false
  const lifecycleId = resolveLifecycleTerminalId(terminalId)
  if (!lifecycleId) {
    return canWriteToPty({ mode: modeFallback ?? 'raw', phase: 'Unknown' }, data)
  }
  const snapshot = sessionStore.read(lifecycleId)
  const mode = snapshot.mode === 'Editor' ? 'Editor' : (modeFallback ?? snapshot.mode)
  return canWriteToPty({ mode, phase: snapshot.phase }, data)
}
