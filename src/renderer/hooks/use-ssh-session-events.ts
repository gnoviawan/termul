import { useEffect } from 'react'
import { startSSHSessionEvents } from '@/lib/ssh-sessions'

/**
 * Route backend SSH session events (progress, host-key questions, ended)
 * into the SSH store for the life of the renderer, and re-adopt live
 * sessions after a reload. A no-op outside the desktop runtime.
 */
export function useSSHSessionEvents(): void {
  useEffect(() => startSSHSessionEvents(), [])
}
