/**
 * Chat notifications for ACP agent chats (issue #853).
 *
 * Fires a notification when the agent needs the user and the user is not
 * already watching that chat:
 * - a turn finished (`acp:prompt_complete`),
 * - a permission card is waiting (`acp:permission_request`),
 * - a structured agent question is waiting (`acp:question_request`).
 *
 * Wires the SAME events `initAcpEventListeners` (acp-store/index.ts) already
 * consumes — `acpApi.onEvent` supports multiple listeners per event on both
 * transports (WS listener-set + Tauri batch fan-out), so this hook adds a
 * parallel subscription instead of touching the store.
 *
 * Anti-spam gate (#853): notify only when the user is not looking —
 * `document.hidden` (page backgrounded / phone locked / another window) OR
 * the session is not the visible chat. The "visible chat" is the active
 * agent-chat tab on the focused pane (the same derivation MobileChatShell
 * uses), falling back to `activeSessionId` on desktop. While the user is
 * watching, the in-app card / activity spinner is the UX — no OS ping.
 *
 * Delivery goes through `sendDesktopNotification` (Tauri plugin on desktop,
 * Web Notifications API in the browser): permission denial is a silent no-op
 * there. NOTE (secure context): the Web Notifications API requires a secure
 * context — plain-HTTP LAN / `0.0.0.0` deployments get no notifications at
 * all (nothing reaches a locked phone either; Web Push / VAPID / sw.js
 * `push` handler is the deferred follow-up, see the issue).
 *
 * Desktop keeps the hook mounted for parity — Tauri notifications for chat
 * events are the same UX on the desktop; both renderer roots mount it.
 */

import { useEffect } from 'react'
import {
  ACP_EVENTS,
  type AskUserQuestionEvent,
  acpApi,
  type PermissionRequestEvent,
  type PromptCompleteEvent
} from '@/lib/acp-api'
import { sanitizeNotificationText, shouldNotifyForTurnEnd } from '@/lib/chat-notify'
import { logFrontendError } from '@/lib/log-api'
import { openAgentChatInOwnProject } from '@/lib/open-agent-chat'
import { sendDesktopNotification } from '@/lib/tauri-notification-api'
import { configIdFromReuseKey } from '@/stores/acp-reuse-keys'
import { useAcpStore } from '@/stores/acp-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'

/**
 * The chat session the user currently sees: the active tab of the focused
 * leaf pane when that tab is an agent chat. Falls back to the store's
 * `activeSessionId` (desktop prepared-chat reaping keeps it meaningful
 * there; web tab isolation lives in `web-tab-session`, not here).
 */
function visibleChatSessionId(): string | null {
  const { root, activePaneId } = useWorkspaceStore.getState()
  const leaves = getAllLeafPanes(root)
  const pane = leaves.find((p) => p.id === activePaneId) ?? leaves[0]
  const activeTab = pane?.tabs.find((t) => t.id === pane?.activeTabId)
  if (activeTab?.type === 'agent-chat') return activeTab.sessionId
  const fallback = useAcpStore.getState().activeSessionId
  return fallback ?? null
}

/** Resolve the configured agent name for a live agent id, if known. */
function agentDisplayName(agentId: string): string | null {
  const state = useAcpStore.getState()
  const reuseKey = Object.keys(state.configToLiveAgent).find(
    (k) => state.configToLiveAgent[k] === agentId
  )
  const configId = reuseKey ? configIdFromReuseKey(reuseKey) : null
  return state.agentConfigs.find((c) => c.id === configId)?.name ?? null
}

/** Display title for a session: session title → agent name → "Agent chat". */
function chatNotificationTitle(sessionId: string): string {
  const state = useAcpStore.getState()
  const session = state.sessions[sessionId]
  return (
    session?.title ??
    (session ? agentDisplayName(session.agentId) : null) ??
    state.sessionIndex.find((e) => e.id === sessionId)?.title ??
    'Agent chat'
  )
}

/**
 * Gate + fire one chat notification. Never throws into the event handler.
 * `stopReason` (turn-finished notifications only) additionally suppresses a
 * notification for a user-initiated cancel.
 */
function notifyChatEvent(
  sessionId: string,
  body: string,
  opts: { stopReason?: string } = {}
): void {
  const state = useAcpStore.getState()
  // Entrance warm-ups (warm-pool prepared sessions) are not real chats.
  if (!state.sessions[sessionId]) return
  const pageHidden = typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false
  const sessionVisible = visibleChatSessionId() === sessionId
  const warranted =
    opts.stopReason !== undefined
      ? shouldNotifyForTurnEnd({ pageHidden, sessionVisible, stopReason: opts.stopReason })
      : pageHidden || !sessionVisible
  if (!warranted) return

  const title = sanitizeNotificationText(chatNotificationTitle(sessionId))
  try {
    // Delivery failure must never break the event stream; log durably.
    void Promise.resolve(
      sendDesktopNotification(title, sanitizeNotificationText(body), {
        onClick: () => {
          // Bring the chat on screen in its own project (switching when it
          // belongs to another one) — the notification layer itself focuses
          // the window (web: window.focus(); desktop: unminimize + setFocus).
          openAgentChatInOwnProject(sessionId, 'use-chat-notifications')
        }
      })
    ).catch((error: unknown) => {
      void logFrontendError({
        level: 'warn',
        message: error instanceof Error ? error.message : String(error),
        source: 'use-chat-notifications'
      })
    })
  } catch (error: unknown) {
    // A synchronous throw from the facade (never expected) is caught here so
    // the event handler still completes.
    void logFrontendError({
      level: 'warn',
      message: error instanceof Error ? error.message : String(error),
      source: 'use-chat-notifications'
    })
  }
}

/**
 * Mount once per app root (both `App.tsx` and `TauriApp.tsx`). Subscribes to
 * the three chat-attention events and fires gated notifications.
 */
export function useChatNotifications(): void {
  useEffect(() => {
    const unsubscribers = [
      acpApi.onEvent<PromptCompleteEvent>(ACP_EVENTS.promptComplete, (e) => {
        notifyChatEvent(e.sessionId, 'Agent finished', { stopReason: e.stopReason })
      }),
      acpApi.onEvent<PermissionRequestEvent>(ACP_EVENTS.permissionRequest, (e) => {
        notifyChatEvent(e.sessionId, 'Agent needs your approval')
      }),
      acpApi.onEvent<AskUserQuestionEvent>(ACP_EVENTS.questionRequest, (e) => {
        notifyChatEvent(e.sessionId, 'Agent asked a question')
      })
    ]
    return () => {
      for (const off of unsubscribers) off()
    }
  }, [])
}
