import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsMobile, mockAddAgentChatTab, mockSelectProfile, acpRef } = vi.hoisted(() => ({
  mockIsMobile: vi.fn(() => false),
  mockAddAgentChatTab: vi.fn(),
  mockSelectProfile: vi.fn(),
  acpRef: {
    current: {
      sessions: {} as Record<string, { projectId: string }>,
      sessionIndex: [] as Array<{ id: string; projectId: string }>,
      switchProject: vi.fn(async () => ({ status: 'selected' })),
      setFailedProjectSwitch: vi.fn()
    }
  }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({ isMobileWebShellViewport: mockIsMobile }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/stores/acp-store', () => ({ useAcpStore: { getState: () => acpRef.current } }))
vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ addAgentChatTab: mockAddAgentChatTab }) }
}))
vi.mock('@/stores/ssh-store', () => ({
  useSSHStore: { getState: () => ({ selectProfile: mockSelectProfile }) }
}))

import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useProjectStore } from '@/stores/project-store'
import { openAgentChatInOwnProject } from './open-agent-chat'

describe('openAgentChatInOwnProject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsMobile.mockReturnValue(false)
    acpRef.current.sessions = { 's-a': { projectId: 'pa' }, 's-b': { projectId: 'pb' } }
    acpRef.current.sessionIndex = []
    useProjectStore.setState({ activeProjectId: 'pa' })
    useAgentChatLifetimeStore.setState({ retainedByProject: {}, focusSessionByProject: {} })
  })

  it('opens a chat of the active project in place', () => {
    openAgentChatInOwnProject('s-a', 'test')
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-a')
    expect(useProjectStore.getState().activeProjectId).toBe('pa')
  })

  it('opens a chat with unknown ownership in place (fail-open)', () => {
    openAgentChatInOwnProject('s-unknown', 'test')
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('s-unknown')
  })

  it('switches to the owning project instead of adding the tab here', () => {
    openAgentChatInOwnProject('s-b', 'test')
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
    expect(useProjectStore.getState().activeProjectId).toBe('pb')
    expect(mockSelectProfile).toHaveBeenCalledWith(null)
    const lifetime = useAgentChatLifetimeStore.getState()
    expect(lifetime.retainedByProject.pb).toEqual(['s-b'])
    expect(lifetime.focusSessionByProject.pb).toBe('s-b')
  })

  it('resolves the owner from the history index for closed chats', () => {
    acpRef.current.sessionIndex = [{ id: 's-closed', projectId: 'pb' }]
    openAgentChatInOwnProject('s-closed', 'test')
    expect(useProjectStore.getState().activeProjectId).toBe('pb')
  })

  it('switches through the server session on the phone shell', () => {
    mockIsMobile.mockReturnValue(true)
    openAgentChatInOwnProject('s-b', 'test')
    expect(acpRef.current.switchProject).toHaveBeenCalledWith('pb')
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
    expect(useAgentChatLifetimeStore.getState().focusSessionByProject.pb).toBe('s-b')
  })
})
