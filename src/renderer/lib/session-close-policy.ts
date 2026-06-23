type CloseSession = { status?: 'running' | 'detached' | 'exited' | 'lost' }

export function getSessionClosePolicy(sessions: CloseSession[]): 'close' | 'prompt' {
  return sessions.some((session) => session.status === 'running' || session.status === 'detached')
    ? 'prompt'
    : 'close'
}
