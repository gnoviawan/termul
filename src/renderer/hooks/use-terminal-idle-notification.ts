import { useEffect } from 'react'
import { terminalApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { sendDesktopNotification } from '@/lib/tauri-notification-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { getCurrentWindow } from '@/lib/tauri-window'
import {
  createTerminalIdleNotifyState,
  evaluateTerminalIdleNotify,
  isViewingTerminal,
  recordTerminalOutput,
  TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS,
  TERMINAL_IDLE_NOTIFY_QUIET_MS,
  type TerminalIdleNotifyState
} from '@/lib/terminal-idle-notify'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'

const MAX_NOTIFICATION_TEXT_LENGTH = 64

function sanitizeNotificationText(
  text: string,
  maxLength: number = MAX_NOTIFICATION_TEXT_LENGTH
): string {
  const sanitized = text.replace(/[\r\n]+/g, ' ').trim()
  if (sanitized.length <= maxLength) return sanitized
  return `${sanitized.slice(0, maxLength - 1)}…`
}

function windowIsFocused(): boolean {
  if (typeof document !== 'undefined' && typeof document.hasFocus === 'function') {
    return document.hasFocus()
  }
  return true
}

async function focusTermulWindow(): Promise<void> {
  try {
    if (isTauriContext()) {
      const win = getCurrentWindow()
      await win.unminimize()
      await win.setFocus()
      return
    }
    window.focus()
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      message: error instanceof Error ? error.message : String(error),
      source: 'terminal-idle-notification:focus'
    })
  }
}

export function activateNotifiedTerminal(terminalId: string): void {
  const terminal = useTerminalStore.getState().terminals.find((t) => t.id === terminalId)
  if (!terminal) return
  useProjectStore.getState().selectProject(terminal.projectId)
  useTerminalStore.getState().selectTerminal(terminal.id)
  useTerminalStore.getState().setTerminalNeedsAttention(terminal.id, false)
  void focusTermulWindow()
}

/**
 * Notify when a terminal that was producing output for a long stretch goes
 * quiet (GH-645: harness agents in a PTY tab). Skips when the user is already
 * watching that tab, and when App Preferences disables the feature.
 */
export function useTerminalIdleNotification(): void {
  useEffect(() => {
    const trackers = new Map<string, TerminalIdleNotifyState>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const clearPty = (ptyId: string): void => {
      const timer = timers.get(ptyId)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(ptyId)
      }
      trackers.delete(ptyId)
    }

    const fireQuiet = (ptyId: string): void => {
      timers.delete(ptyId)
      const state = trackers.get(ptyId)
      if (!state) return

      const result = evaluateTerminalIdleNotify(state, Date.now(), {
        quietMs: TERMINAL_IDLE_NOTIFY_QUIET_MS,
        minBusyMs: TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS
      })
      trackers.set(ptyId, result.next)
      if (result.kind !== 'notify') return

      if (!useAppSettingsStore.getState().settings.notifyOnTerminalIdle) return

      const terminalState = useTerminalStore.getState()
      const terminal = terminalState.findTerminalByPtyId(ptyId)
      if (!terminal) return

      const viewing = isViewingTerminal({
        activeTerminalId: terminalState.activeTerminalId,
        terminalId: terminal.id,
        windowFocused: windowIsFocused(),
        isAppHidden: Boolean(terminal.isAppHidden)
      })
      if (viewing) return

      terminalState.setTerminalNeedsAttention(terminal.id, true)

      const project = useProjectStore.getState().projects.find((p) => p.id === terminal.projectId)
      const title = sanitizeNotificationText(project?.name ?? 'Termul')
      const terminalName = sanitizeNotificationText(terminal.name)
      void sendDesktopNotification(title, `${terminalName} — agent finished`, {
        onClick: () => activateNotifiedTerminal(terminal.id)
      })
    }

    const unsubData = terminalApi.onData((ptyId: string, data: Uint8Array) => {
      if (!data || data.length === 0) return
      if (!useAppSettingsStore.getState().settings.notifyOnTerminalIdle) {
        clearPty(ptyId)
        return
      }

      const prev = trackers.get(ptyId) ?? createTerminalIdleNotifyState()
      trackers.set(ptyId, recordTerminalOutput(prev, Date.now()))

      const existing = timers.get(ptyId)
      if (existing !== undefined) clearTimeout(existing)
      timers.set(
        ptyId,
        setTimeout(() => {
          fireQuiet(ptyId)
        }, TERMINAL_IDLE_NOTIFY_QUIET_MS)
      )
    })

    const unsubExit = terminalApi.onExit((ptyId: string) => {
      clearPty(ptyId)
    })

    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
      trackers.clear()
      unsubData()
      unsubExit()
    }
  }, [])
}
