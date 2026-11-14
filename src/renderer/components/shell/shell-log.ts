import { logFrontendError } from '@/lib/log-api'

/**
 * One durable line for a shell frame flow (right panel shown or hidden, a tab
 * opened from the tool strip). Pass view names and ids only, never a path or
 * a title.
 */
export function logShellEvent(message: string, level: 'info' | 'error' = 'info'): void {
  void logFrontendError({ level, source: 'Shell', message: `[shell] ${message}` })
}
