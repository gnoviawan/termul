import { logFrontendError } from '@/lib/log-api'

/**
 * One durable line for a Rail flow (new chat, open chat, expand or collapse,
 * a chat opened from the hover peek). Pass ids only, never a chat title or
 * prompt text.
 */
export function logRailEvent(message: string, level: 'info' | 'error' = 'info'): void {
  void logFrontendError({ level, source: 'Rail', message: `[rail] ${message}` })
}
