import { create } from 'zustand'

/** Chats whose Codex account restart has not finished. */
const restarting = new Set<string>()

/** Reactive copy so the composer can disable while a restart runs. */
export const useCodexRestartingStore = create<{ ids: readonly string[] }>(() => ({ ids: [] }))

export function setCodexAccountRestarting(sessionId: string, active: boolean): void {
  if (active) restarting.add(sessionId)
  else restarting.delete(sessionId)
  useCodexRestartingStore.setState({ ids: [...restarting] })
}

/** True while this chat's Codex account restart has not finished. */
export function isCodexAccountRestarting(sessionId: string): boolean {
  return restarting.has(sessionId)
}
