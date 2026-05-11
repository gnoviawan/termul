import { useEffect } from 'react'
import { terminalApi } from '@/lib/api'
import { sendDesktopNotification } from '@/lib/tauri-notification-api'
import { useTerminalStore } from '@/stores/terminal-store'
import { useProjectStore } from '@/stores/project-store'

/**
 * Maximum length for notification title and body before truncation.
 * OS notifications have limited display space; long names get cut off.
 */
const MAX_NOTIFICATION_TEXT_LENGTH = 64

/**
 * Truncate and sanitize a string for use in OS notifications.
 * Removes newlines and limits length to prevent overflow or spoofed formatting.
 */
function sanitizeNotificationText(text: string, maxLength: number = MAX_NOTIFICATION_TEXT_LENGTH): string {
  const sanitized = text.replace(/[\r\n]+/g, ' ').trim()
  if (sanitized.length <= maxLength) return sanitized
  return sanitized.slice(0, maxLength - 1) + '…'
}

/**
 * Hook that listens for terminal-exit events and sends a desktop notification
 * with the project title and terminal title when a terminal process finishes.
 *
 * Notification format:
 *   Title: <project name>  (or "Termul" if project unknown)
 *   Body:  <terminal name> — DONE
 *          or <terminal name> — Failed (exit code: N) for non-zero exit
 */
export function useTerminalExitNotification(): void {
  useEffect(() => {
    const cleanup = terminalApi.onExit((ptyId: string, exitCode: number) => {
      const terminal = useTerminalStore.getState().findTerminalByPtyId(ptyId)
      if (!terminal) return

      const project = useProjectStore
        .getState()
        .projects.find((p) => p.id === terminal.projectId)

      const title = sanitizeNotificationText(project?.name ?? 'Termul')
      const terminalName = sanitizeNotificationText(terminal.name)

      const body =
        exitCode === 0
          ? `${terminalName} — DONE`
          : `${terminalName} — Failed (exit ${exitCode})`

      sendDesktopNotification(title, body)
    })

    return cleanup
  }, [])
}