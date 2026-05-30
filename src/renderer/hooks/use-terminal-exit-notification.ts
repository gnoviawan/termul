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
 * Hook that listens for terminal-exit events and (1) sends a desktop notification
 * with the project title and terminal title when a terminal process finishes, and
 * (2) flags the terminal with `needsAttention` so the workspace can render an in-app
 * highlight border on the finished terminal (cross-OS, no notification-click needed).
 *
 * Notification format:
 *   Title: <project name>  (or "Termul" if project unknown)
 *   Body:  <terminal name> — DONE
 *          or <terminal name> — Failed (exit code: N) for non-zero exit
 */
export function useTerminalExitNotification(): void {
  useEffect(() => {
    const cleanup = terminalApi.onExit((ptyId: string, exitCode: number) => {
      const terminalState = useTerminalStore.getState()
      const terminal = terminalState.findTerminalByPtyId(ptyId)
      if (!terminal) return

      // Flag the terminal for the in-app highlight border when its process finishes
      // while the user is not already looking at it. "Viewing" requires BOTH that this
      // is the active terminal AND the window is currently focused. document.hasFocus()
      // is synchronous and accurate at the exit instant, avoiding the async isAppHidden
      // update race; isAppHidden is kept as a fallback for environments where focus is
      // unreliable (e.g. some tests/headless).
      const windowFocused =
        typeof document !== 'undefined' && typeof document.hasFocus === 'function'
          ? document.hasFocus()
          : !terminal.isAppHidden
      const isViewingThisTerminal =
        terminalState.activeTerminalId === terminal.id &&
        windowFocused &&
        !terminal.isAppHidden
      if (!isViewingThisTerminal) {
        terminalState.setTerminalNeedsAttention(terminal.id, true)
      }

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