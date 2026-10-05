/**
 * Chat-notification decision tests (issue #853).
 *
 * Pure-policy coverage (acceptance): backgrounded + turn finished → notify;
 * focused/visible session → no notify; cancelled turns never notify; the
 * hook additionally gates on the visible-chat derivation and fires through
 * `sendDesktopNotification`.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldNotifyForChatEvent, shouldNotifyForTurnEnd } from '@/lib/chat-notify'
import { sendDesktopNotification } from '@/lib/tauri-notification-api'
import { mockAcpSession } from '@/lib/test-utils/acp'
import { useAcpStore } from '@/stores/acp-store'
import { useChatNotifications } from './use-chat-notifications'

vi.mock('@/lib/tauri-notification-api', () => ({
  sendDesktopNotification: vi.fn()
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn(() => Promise.resolve())
}))

// Transport-level events: drive the hook through the (mocked) acpApi event
// seam without a socket. The mock records subscriptions per event name so
// tests can emit events like the real transports would.
const listeners = new Map<string, Array<(payload: unknown) => void>>()

vi.mock('@/lib/acp-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/acp-api')>()
  return {
    ...actual,
    acpApi: {
      onEvent: (name: string, cb: (payload: unknown) => void) => {
        const set = listeners.get(name) ?? []
        set.push(cb)
        listeners.set(name, set)
        return () => {
          const current = listeners.get(name) ?? []
          const i = current.indexOf(cb)
          if (i >= 0) current.splice(i, 1)
        }
      }
    }
  }
})

type WorkspaceTabLike = { type: string; sessionId?: string; id: string }

const workspaceState = {
  root: {
    type: 'leaf',
    id: 'leaf-1',
    activeTabId: null as string | null,
    tabs: [] as WorkspaceTabLike[]
  },
  activePaneId: 'leaf-1',
  addAgentChatTab: vi.fn((sessionId: string) => {
    const id = `chat-${sessionId}`
    const tab: WorkspaceTabLike = { type: 'agent-chat', sessionId, id }
    workspaceState.root = { ...workspaceState.root, tabs: [...workspaceState.root.tabs, tab] }
    workspaceState.root = { ...workspaceState.root, activeTabId: id }
  })
}

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((selector: (state: typeof workspaceState) => unknown) => selector(workspaceState)),
    { getState: () => workspaceState }
  ),
  getAllLeafPanes: (root: unknown) => [root]
}))

function emit(name: string, payload: unknown): void {
  for (const cb of [...(listeners.get(name) ?? [])]) cb(payload)
}

/** Make `sessionId` the active agent-chat tab of the focused pane. */
function makeSessionVisible(sessionId: string): void {
  workspaceState.root = {
    ...workspaceState.root,
    tabs: [{ type: 'agent-chat', sessionId, id: `chat-${sessionId}` }],
    activeTabId: `chat-${sessionId}`
  }
}

const SESSION_ID = 's1'

describe('shouldNotifyForChatEvent / shouldNotifyForTurnEnd (pure policy)', () => {
  it('notifies for a backgrounded page even when the session is the visible chat', () => {
    expect(shouldNotifyForChatEvent({ pageHidden: true, sessionVisible: true })).toBe(true)
    expect(
      shouldNotifyForTurnEnd({ pageHidden: true, sessionVisible: true, stopReason: 'end_turn' })
    ).toBe(true)
  })

  it('notifies for a visible page when the session is NOT the visible chat', () => {
    expect(shouldNotifyForChatEvent({ pageHidden: false, sessionVisible: false })).toBe(true)
    expect(
      shouldNotifyForTurnEnd({ pageHidden: false, sessionVisible: false, stopReason: 'end_turn' })
    ).toBe(true)
  })

  it('does not notify while the user is watching the session on a visible page', () => {
    expect(shouldNotifyForChatEvent({ pageHidden: false, sessionVisible: true })).toBe(false)
    expect(
      shouldNotifyForTurnEnd({ pageHidden: false, sessionVisible: true, stopReason: 'end_turn' })
    ).toBe(false)
  })

  it('never notifies for a user-initiated cancel', () => {
    // The user cancelled the turn — they are at the controls.
    expect(
      shouldNotifyForTurnEnd({ pageHidden: true, sessionVisible: false, stopReason: 'cancelled' })
    ).toBe(false)
    expect(
      shouldNotifyForTurnEnd({ pageHidden: true, sessionVisible: true, stopReason: 'cancelled' })
    ).toBe(false)
  })

  it('notifies for non-end_turn stop reasons (errors, max_tokens, refusal)', () => {
    for (const stopReason of ['max_tokens', 'refusal', 'insufficient_credit']) {
      expect(shouldNotifyForTurnEnd({ pageHidden: true, sessionVisible: false, stopReason })).toBe(
        true
      )
    }
  })
})

describe('useChatNotifications', () => {
  const originalVisibility = document.visibilityState

  function setPageHidden(hidden: boolean): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: hidden ? 'hidden' : 'visible'
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    listeners.clear()
    workspaceState.root = { type: 'leaf', id: 'leaf-1', activeTabId: null, tabs: [] }
    useAcpStore.setState({
      sessions: { [SESSION_ID]: mockAcpSession({ id: SESSION_ID, title: 'Fix login bug' }) },
      activeSessionId: null,
      agentConfigs: [],
      configToLiveAgent: {},
      sessionIndex: []
    })
    setPageHidden(false)
  })

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: originalVisibility
    })
  })

  it('notifies for a finished turn while the page is backgrounded', () => {
    renderHook(() => useChatNotifications())
    setPageHidden(true)

    emit('acp:prompt_complete', {
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      stopReason: 'end_turn'
    })

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
    expect(sendDesktopNotification).toHaveBeenCalledWith(
      'Fix login bug',
      'Agent finished',
      expect.objectContaining({ onClick: expect.any(Function) })
    )
  })

  it('notifies for a finished turn while another chat is visible (page focused)', () => {
    renderHook(() => useChatNotifications())
    makeSessionVisible('s-other')

    emit('acp:prompt_complete', {
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      stopReason: 'end_turn'
    })

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
  })

  it('does not notify while the user is watching the session on a visible page', () => {
    renderHook(() => useChatNotifications())
    makeSessionVisible(SESSION_ID)

    emit('acp:prompt_complete', {
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      stopReason: 'end_turn'
    })

    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })

  it('does not notify a cancelled turn even when backgrounded', () => {
    renderHook(() => useChatNotifications())
    setPageHidden(true)

    emit('acp:prompt_complete', {
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      stopReason: 'cancelled'
    })

    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })

  it('notifies when a permission card is waiting (page backgrounded)', () => {
    renderHook(() => useChatNotifications())
    setPageHidden(true)

    emit('acp:permission_request', {
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      requestId: 'req-1',
      toolCall: {},
      options: []
    })

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
    expect(sendDesktopNotification).toHaveBeenCalledWith(
      'Fix login bug',
      'Agent needs your approval',
      expect.objectContaining({ onClick: expect.any(Function) })
    )
  })

  it('notifies when a permission is requested for a non-visible chat on a focused page', () => {
    renderHook(() => useChatNotifications())
    makeSessionVisible('s-other')

    emit('acp:permission_request', {
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      requestId: 'req-1',
      toolCall: {},
      options: []
    })

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
  })

  it('does not notify a permission request while the user is watching the chat', () => {
    renderHook(() => useChatNotifications())
    makeSessionVisible(SESSION_ID)

    emit('acp:permission_request', {
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      requestId: 'req-1',
      toolCall: {},
      options: []
    })

    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })

  it('notifies when an agent question is waiting (page backgrounded)', () => {
    renderHook(() => useChatNotifications())
    setPageHidden(true)

    emit('acp:question_request', {
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      questionId: 'q-1',
      question: 'Which database?',
      options: []
    })

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
    expect(sendDesktopNotification).toHaveBeenCalledWith(
      'Fix login bug',
      'Agent asked a question',
      expect.objectContaining({ onClick: expect.any(Function) })
    )
  })

  it('skips events for unknown sessions (warm-pool entrance warm-up)', () => {
    renderHook(() => useChatNotifications())
    setPageHidden(true)

    emit('acp:prompt_complete', {
      agentId: 'agent-1',
      sessionId: 'unknown-session',
      stopReason: 'end_turn'
    })

    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })

  it('falls back to the agent config name when the session has no title', () => {
    useAcpStore.setState({
      sessions: { [SESSION_ID]: mockAcpSession({ id: SESSION_ID, title: null }) },
      agentConfigs: [{ id: 'cfg-1', name: 'Claude', command: 'claude', args: [], env: {} }],
      configToLiveAgent: { 'cfg-1 /work': 'agent-1' }
    })
    renderHook(() => useChatNotifications())
    setPageHidden(true)

    emit('acp:prompt_complete', {
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      stopReason: 'end_turn'
    })

    expect(sendDesktopNotification).toHaveBeenCalledWith(
      'Claude',
      'Agent finished',
      expect.objectContaining({ onClick: expect.any(Function) })
    )
  })

  it('notification click activates the chat tab', () => {
    renderHook(() => useChatNotifications())
    setPageHidden(true)

    emit('acp:prompt_complete', {
      agentId: 'agent-1',
      sessionId: SESSION_ID,
      stopReason: 'end_turn'
    })

    const onClick = vi.mocked(sendDesktopNotification).mock.calls[0]?.[2]?.onClick
    expect(onClick).toBeTypeOf('function')
    act(() => {
      onClick?.()
    })

    // The chat tab now exists and is active in the (mocked) pane tree.
    expect(workspaceState.addAgentChatTab).toHaveBeenCalledWith(SESSION_ID)
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useChatNotifications())
    expect(listeners.get('acp:prompt_complete')).toHaveLength(1)
    unmount()
    expect(listeners.get('acp:prompt_complete')).toHaveLength(0)
    expect(listeners.get('acp:permission_request')).toHaveLength(0)
    expect(listeners.get('acp:question_request')).toHaveLength(0)
  })
})
