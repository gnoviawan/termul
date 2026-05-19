export type TerminalTakeoverClientType = 'web' | 'tauri'

export interface TerminalTakeoverPayload {
  terminalId: string
  clientType: TerminalTakeoverClientType
}

export interface TerminalTakeoverState {
  isOwner: boolean
  isSuspended: boolean
}

export function resolveTerminalTakeoverState(
  currentTerminalId: string | undefined,
  payload: TerminalTakeoverPayload
): TerminalTakeoverState | null {
  if (!currentTerminalId || payload.terminalId !== currentTerminalId) {
    return null
  }

  if (payload.clientType === 'web') {
    return { isOwner: false, isSuspended: true }
  }

  return { isOwner: true, isSuspended: false }
}

export function handleTerminalTakeoverEvent(
  currentTerminalId: string | undefined,
  payload: TerminalTakeoverPayload,
  applyState: (state: TerminalTakeoverState) => void
): void {
  const takeoverState = resolveTerminalTakeoverState(currentTerminalId, payload)

  if (takeoverState) {
    applyState(takeoverState)
  }
}
