import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendDesktopNotification } from '@/lib/tauri-notification-api'
import { mockProject, seedAppSettingsStore, seedProjectStore } from '@/lib/test-utils/store'
import { type AcpSession, useAcpStore } from '@/stores/acp-store'
import { useAgentChatNotification } from './use-agent-chat-notification'

vi.mock('@/lib/tauri-notification-api', () => ({
  sendDesktopNotification: vi.fn()
}))

function session(overrides: Partial<AcpSession> = {}): AcpSession {
  return {
    id: 's1',
    agentId: 'agent-1',
    cwd: '/work',
    projectId: 'proj-1',
    status: 'active',
    title: 'Deploy',
    activeTurn: true,
    openTurnId: 'turn-1',
    modes: null,
    models: null,
    configOptions: [],
    lastError: null,
    createdAt: 1,
    ...overrides
  }
}

describe('useAgentChatNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    seedAppSettingsStore({
      notifyOnAgentChatTurnFinished: true,
      notifyOnAgentChatNeedsYou: true
    })
    seedProjectStore([mockProject({ id: 'proj-1', name: 'My Project' })], 'proj-1')
    useAcpStore.setState({
      sessions: { s1: session() },
      sessionIndex: [],
      turnEndNotices: {},
      promptQueues: {},
      pendingPermissions: {},
      pendingQuestions: {}
    })
  })

  it('sends one notification when a live turn finishes', () => {
    renderHook(() => useAgentChatNotification())

    act(() => {
      useAcpStore.setState({
        sessions: { s1: session({ activeTurn: false, openTurnId: null }) },
        turnEndNotices: { s1: { seq: 1, stopReason: 'end_turn' } },
        promptQueues: { s1: [] }
      })
    })

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
    expect(sendDesktopNotification).toHaveBeenCalledWith('My Project', 'Deploy — finished')
  })

  it('sends one notification for a new permission request', () => {
    renderHook(() => useAgentChatNotification())

    act(() => {
      useAcpStore.setState({
        pendingPermissions: {
          'req-1': {
            requestId: 'req-1',
            agentId: 'agent-1',
            sessionId: 's1',
            options: [],
            toolCall: null
          }
        }
      })
    })

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
    expect(sendDesktopNotification).toHaveBeenCalledWith('My Project', 'Deploy — needs approval')
  })
})
