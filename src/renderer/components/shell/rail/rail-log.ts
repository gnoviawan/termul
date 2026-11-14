import { logFrontendError } from '@/lib/log-api'

/**
 * One durable info line for a Rail flow (new chat, open chat). Pass ids only,
 * never a chat title or prompt text.
 */
export function logRailEvent(message: string): void {
  void logFrontendError({ level: 'info', source: 'Rail', message: `[rail] ${message}` })
}
