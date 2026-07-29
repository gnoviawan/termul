import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpSession } from '@/stores/acp-store'

const {
  mockOpen,
  mockOpenDiscovered,
  sessionRef,
  indexRef,
  openingRef,
  restoringRef,
  launchingRef,
  oskRef,
  transportReconnectingRef,
  discoveredContextRef
} = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockOpenDiscovered: vi.fn(),
  // AcpSession shape; typed loosely here because vi.hoisted runs before the
  // type-only import below is usable at runtime. `seedLiveSession` constructs
  // the value with a `satisfies AcpSession` check.
  sessionRef: { current: null as object | null },
  indexRef: { current: [] as Array<{ id: string }> },
  openingRef: { current: {} as Record<string, true> },
  restoringRef: { current: {} as Record<string, true> },
  launchingRef: { current: {} as Record<string, true> },
  // Story 5.3 (AC1/AC3): test seams for OSK + reconnect overlay.
  oskRef: { current: { isOskOpen: false, keyboardHeight: 0, height: 0, offsetTop: 0 } },
  transportReconnectingRef: { current: false },
  discoveredContextRef: {
    current: {} as Record<string, { agentId: string; cwd: string; projectId: string }>
  }
}))

vi.mock('@/stores/acp-store', () => {
  const state = () => ({
    agents: {},
    commands: {},
    toolCalls: {},
    plans: {},
    pendingPermissions: {},
    sessions: {},
    configToLiveAgent: {},
    sessionIndex: indexRef.current,
    openingHistoryIds: openingRef.current,
    restoringChatIds: restoringRef.current,
    launchingSessionIds: launchingRef.current,
    discoveredReopenContexts: discoveredContextRef.current,
    transportReconnecting: transportReconnectingRef.current,
    openHistorySession: mockOpen,
    openDiscoveredSession: mockOpenDiscovered,
    sendPrompt: vi.fn(),
    sendPromptBlocks: vi.fn(),
    cancelPrompt: vi.fn(),
    removeQueuedPrompt: vi.fn(),
    sendQueuedPromptNow: vi.fn(),
    retryCrashedSession: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn(),
    setMode: vi.fn(),
    setModel: vi.fn()
  })
  return {
    useAcpStore: (sel: (s: unknown) => unknown) => sel(state()),
    useAcpSession: () => sessionRef.current,
    useAcpMessages: () => [],
    usePromptQueue: () => [],
    configIdFromReuseKey: (key: string) => key
  }
})

// Story 5.3 (AC1): mock the OSK + mobile shell hooks so we can drive
// `isOskOpen` / `keyboardHeight` from the test seam.
vi.mock('@/hooks/use-osk-viewport', () => ({
  useOskViewport: () => oskRef.current
}))
vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => true
}))

vi.mock('./PlanSupportHint', () => ({ PlanSupportHint: () => null }))

// Child components pull in heavy chat rendering; the states under test render
// before any of them mount.
vi.mock('./ChatErrorNotice', () => ({ ChatErrorNotice: () => null }))
vi.mock('./ChatInputBar', () => ({ ChatInputBar: () => null }))
vi.mock('./ChatMessageList', () => ({ ChatMessageList: () => null }))
vi.mock('./PermissionDialog', () => ({ PermissionDialog: () => null }))
vi.mock('./PlanPanel', () => ({ PlanPanel: () => null }))
vi.mock('./chat-timeline', () => ({
  buildTimeline: () => [],
  consolidateThoughtGroups: (items: unknown[]) => items
}))

import { AgentChatPanel } from './AgentChatPanel'

function seedLiveSession(id: string, lastError: string | null = null): void {
  sessionRef.current = {
    id,
    agentId: 'agent-1',
    cwd: '/w',
    projectId: 'p1',
    status: 'closed',
    title: null,
    activeTurn: false,
    openTurnId: null,
    modes: null,
    models: null,
    configOptions: [],
    lastError,
    createdAt: 1
  } satisfies AcpSession
}

describe('AgentChatPanel restored-tab rehydration', () => {
  beforeEach(() => {
    mockOpen.mockReset().mockResolvedValue(undefined)
    mockOpenDiscovered.mockReset().mockResolvedValue(undefined)
    sessionRef.current = null
    indexRef.current = []
    openingRef.current = {}
    restoringRef.current = {}
    launchingRef.current = {}
    oskRef.current = { isOskOpen: false, keyboardHeight: 0, height: 0, offsetTop: 0 }
    transportReconnectingRef.current = false
    discoveredContextRef.current = {}
  })

  it('shows a branded preload while rehydrating a visible restored tab', () => {
    indexRef.current = [{ id: 's1' }]
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByRole('status', { name: 'Restoring chat' })).toBeInTheDocument()
    expect(screen.getByText('Loading your conversation…')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Termul' })).toBeInTheDocument()
    expect(mockOpen).toHaveBeenCalledTimes(1)
    expect(mockOpen).toHaveBeenCalledWith('s1')
  })

  it('keeps the branded preload visible while a placeholder session exists', () => {
    seedLiveSession('s1')
    restoringRef.current = { s1: true }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByRole('status', { name: 'Restoring chat' })).toBeInTheDocument()
    const mark = screen.getByRole('img', { name: 'Termul' })
    expect(mark).toHaveClass('animate-pulse')
    expect(mark).toHaveClass('motion-reduce:animate-none')
    expect(
      screen.getByRole('status', { name: 'Restoring chat' }).querySelectorAll('svg')
    ).toHaveLength(1)
  })

  it('marks the live chat pane root as a pane-scoped @container (Story 5.1)', () => {
    seedLiveSession('s1')
    const { container } = render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(container.firstElementChild?.className).toContain('@container')
    expect(container.firstElementChild?.className).toMatch(/flex h-full flex-col/)
  })

  it('does not rehydrate a hidden tab (no background cold spawns)', () => {
    indexRef.current = [{ id: 's1' }]
    render(<AgentChatPanel sessionId="s1" isVisible={false} />)
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('rehydrates when a hidden tab becomes the active tab', () => {
    indexRef.current = [{ id: 's1' }]
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible={false} />)
    expect(mockOpen).not.toHaveBeenCalled()
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(mockOpen).toHaveBeenCalledTimes(1)
    expect(mockOpen).toHaveBeenCalledWith('s1')
  })

  it('keeps the placeholder when no history exists for the tab', () => {
    render(<AgentChatPanel sessionId="s-gone" isVisible />)
    expect(screen.getByText(/No active chat for this pane/)).toBeInTheDocument()
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('surfaces a rehydrate failure with a retry affordance', async () => {
    indexRef.current = [{ id: 's1' }]
    mockOpen.mockRejectedValueOnce(new Error('spawn boom'))
    render(<AgentChatPanel sessionId="s1" isVisible />)
    await waitFor(() => {
      expect(screen.getByText(/Failed to restore chat/)).toBeInTheDocument()
    })
    // Retry clears the error and re-attempts the open.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalledTimes(2)
    })
  })

  it('shows a reconnecting banner while a closed session is being reopened', () => {
    seedLiveSession('s1')
    openingRef.current = { s1: true }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByText(/Reconnecting to agent/)).toBeInTheDocument()
  })

  it('keeps the failed discovered restore banner hidden while reopen is pending', () => {
    seedLiveSession('s1')
    discoveredContextRef.current = {
      s1: { agentId: 'agent-native', cwd: '/native', projectId: 'p-native' }
    }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.queryByText('Failed to restore agent chat.')).not.toBeInTheDocument()
  })

  it('offers Retry for a failed discovered reopen and retries with ephemeral context', () => {
    seedLiveSession('s1', 'native load failed')
    discoveredContextRef.current = {
      s1: { agentId: 'agent-native', cwd: '/native', projectId: 'p-native' }
    }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByText('Failed to restore agent chat.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mockOpenDiscovered).toHaveBeenCalledWith('agent-native', 's1', '/native', 'p-native')
  })

  it('offers a Reconnect action for a closed session with history (no dead end)', () => {
    // A failed background reconnect leaves the session registered but closed;
    // the pane must offer a working way to re-attempt the reopen.
    seedLiveSession('s1')
    indexRef.current = [{ id: 's1' }]
    render(<AgentChatPanel sessionId="s1" isVisible />)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(mockOpen).toHaveBeenCalledWith('s1')
  })
})

// Story 5.3 (AC1, AC3, AC4) — OSK spacer + reconnect overlay.
describe('AgentChatPanel OSK + reconnect overlay (Story 5.3)', () => {
  beforeEach(() => {
    mockOpen.mockReset().mockResolvedValue(undefined)
    mockOpenDiscovered.mockReset().mockResolvedValue(undefined)
    sessionRef.current = null
    indexRef.current = []
    openingRef.current = {}
    restoringRef.current = {}
    launchingRef.current = {}
    oskRef.current = { isOskOpen: false, keyboardHeight: 0, height: 0, offsetTop: 0 }
    transportReconnectingRef.current = false
    discoveredContextRef.current = {}
  })

  it('applies OSK bottom padding when the OSK is open on mobile (AC1)', () => {
    seedLiveSession('s1')
    oskRef.current = { isOskOpen: true, keyboardHeight: 300, height: 500, offsetTop: 300 }
    const { container } = render(<AgentChatPanel sessionId="s1" isVisible />)
    const root = container.firstElementChild as HTMLElement
    expect(root.style.paddingBottom).toContain('300px')
  })

  it('does not apply OSK padding when the OSK is closed (desktop non-regression)', () => {
    seedLiveSession('s1')
    const { container } = render(<AgentChatPanel sessionId="s1" isVisible />)
    const root = container.firstElementChild as HTMLElement
    expect(root.style.paddingBottom).toBe('')
  })

  it('renders the transport reconnect overlay when transportReconnecting is true (AC3)', () => {
    seedLiveSession('s1')
    transportReconnectingRef.current = true
    render(<AgentChatPanel sessionId="s1" isVisible />)
    // The overlay reuses AgentConnectionLamp (amber) and shows "Reconnecting…"
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('does not render the transport reconnect overlay when transportReconnecting is false (AC3)', () => {
    seedLiveSession('s1')
    transportReconnectingRef.current = false
    render(<AgentChatPanel sessionId="s1" isVisible />)
    // The transport-level overlay must be absent. (The session-level
    // "Reconnecting to agent…" banner is also absent because the session
    // isn't closed + reopening.)
    expect(screen.queryByText(/^Reconnecting$/)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('the reconnect overlay container is pointer-events-none (non-blocking, AC3)', () => {
    seedLiveSession('s1')
    transportReconnectingRef.current = true
    const { container } = render(<AgentChatPanel sessionId="s1" isVisible />)
    // The overlay chip lives at top-right; it must not block clicks on
    // already-rendered messages.
    const status = screen.getByRole('status')
    const overlay = status.closest('[class*="pointer-events-none"]')
    expect(overlay).not.toBeNull()
    void container
  })
})
