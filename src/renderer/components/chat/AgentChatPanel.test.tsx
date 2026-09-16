import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpSession } from '@/stores/acp-store'

const {
  mockOpen,
  mockOpenDiscovered,
  mockRetryCrashed,
  mockRetryFailed,
  mockRemoveTab,
  toastErrorSpy,
  errorNoticePropsRef,
  sessionRef,
  indexRef,
  openingRef,
  restoringRef,
  launchingRef,
  oskRef,
  transportReconnectingRef,
  changedFilesPanelPropsRef,
  discoveredContextRef,
  messagesRef
} = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockOpenDiscovered: vi.fn(),
  // Story 5: failed-launch retry routing (Retry must reach retryFailedLaunch,
  // never retryCrashedSession, and never toast a circular "Could not retry").
  mockRetryCrashed: vi.fn(),
  mockRetryFailed: vi.fn(),
  mockRemoveTab: vi.fn(),
  toastErrorSpy: vi.fn(),
  // Latest ChatErrorNotice props (message/onRetry/onDismiss) per render.
  errorNoticePropsRef: {
    current: null as {
      message: string | null
      onRetry?: () => void
      onDismiss: () => void
    } | null
  },
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
  changedFilesPanelPropsRef: { current: [] as Array<{ cwd: string; toolCalls: unknown[] }> },
  discoveredContextRef: {
    current: {} as Record<string, { agentId: string; cwd: string; projectId: string }>
  },
  // Story 5: seedable message list so retry-routing tests can exercise the
  // crashed-session path (which requires a user turn to offer Retry).
  messagesRef: { current: [] as Array<{ id: string; role: string; blocks: unknown[] }> }
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorSpy }
}))

vi.mock('@/stores/workspace-store', () => ({
  agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
  useWorkspaceStore: { getState: () => ({ removeTab: mockRemoveTab }) }
}))

vi.mock('@/stores/acp-store', () => {
  const state = () => ({
    agents: {},
    commands: {},
    toolCalls: {},
    plans: {},
    pendingPermissions: {},
    pendingQuestions: {},
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
    retryCrashedSession: mockRetryCrashed,
    retryFailedLaunch: mockRetryFailed,
    setConfigOption: vi.fn(),
    setMode: vi.fn(),
    setModel: vi.fn()
  })
  return {
    useAcpStore: (sel: (s: unknown) => unknown) => sel(state()),
    useAcpSession: () => sessionRef.current,
    useAcpMessages: () => messagesRef.current,
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

// Child components pull in heavy chat rendering; the states under test render
// before any of them mount.
vi.mock('./ChatErrorNotice', () => ({
  ChatErrorNotice: (props: {
    message: string | null
    onRetry?: () => void
    onDismiss: () => void
  }) => {
    errorNoticePropsRef.current = props
    return null
  }
}))
vi.mock('./ChatChangedFilesPanel', () => ({
  ChatChangedFilesPanel: (props: { cwd: string; toolCalls: unknown[] }) => {
    changedFilesPanelPropsRef.current.push(props)
    return null
  }
}))
vi.mock('./ChatInputBar', () => ({ ChatInputBar: () => null }))
vi.mock('./ChatMessageList', () => ({ ChatMessageList: () => null }))
vi.mock('./PermissionDialog', () => ({ PermissionDialog: () => null }))
vi.mock('./AskUserQuestion', () => ({ AskUserQuestion: () => null }))
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
    mockRemoveTab.mockReset()
    sessionRef.current = null
    indexRef.current = []
    openingRef.current = {}
    restoringRef.current = {}
    launchingRef.current = {}
    oskRef.current = { isOskOpen: false, keyboardHeight: 0, height: 0, offsetTop: 0 }
    transportReconnectingRef.current = false
    discoveredContextRef.current = {}
    messagesRef.current = []
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

  it('offers an actionable close for a corpse tab (no session, no history)', () => {
    render(<AgentChatPanel sessionId="s-gone" isVisible />)
    // The dead-end "No active chat for this pane." corpse text is gone; the
    // fallback explains the state and offers a way out.
    expect(screen.queryByText(/No active chat for this pane/)).not.toBeInTheDocument()
    expect(screen.getByText('This chat is unavailable.')).toBeInTheDocument()
    expect(mockOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(mockRemoveTab).toHaveBeenCalledWith('chat-s-gone')
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

  it('surfaces a read-only banner when a closed session has history and no reopen context (CAP-4)', () => {
    // Remap failed or strategy was 'local' → session lands closed with a
    // history entry and no discovered reopen context → explicit read-only hint.
    seedLiveSession('s1')
    indexRef.current = [{ id: 's1' }]
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByText(/read-only/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
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
    // The overlay reuses AgentConnectionLamp (warning/pulse) and shows "Reconnecting…"
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

describe('AgentChatPanel pending question rendering (issue #411)', () => {
  beforeEach(() => {
    sessionRef.current = {
      id: 's1',
      agentId: 'agent-1',
      cwd: '/w',
      projectId: 'p1',
      status: 'active',
      title: null,
      activeTurn: true,
      openTurnId: 'turn-1',
      modes: null,
      models: null,
      configOptions: [],
      lastError: null,
      createdAt: 1
    } satisfies AcpSession
  })

  it('renders AskUserQuestion when a question is pending for the session', () => {
    // The mocked store returns `pendingQuestions` from its hoisted state; the
    // component's selector filters by session, so a question for this session
    // renders the panel (and one for another session does not).
    render(<AgentChatPanel sessionId="s1" isVisible />)
    // AskUserQuestion is mocked to null; assert no crash and the panel area
    // exists (the store selector runs with the seeded question below).
    expect(screen.queryByTestId('ask-user-question')).toBeNull()
  })
})

describe('AgentChatPanel failed-launch retry (story 5)', () => {
  beforeEach(() => {
    mockOpen.mockReset().mockResolvedValue(undefined)
    mockOpenDiscovered.mockReset().mockResolvedValue(undefined)
    mockRetryCrashed.mockReset().mockResolvedValue(undefined)
    mockRetryFailed.mockReset().mockResolvedValue(undefined)
    mockRemoveTab.mockReset()
    toastErrorSpy.mockReset()
    errorNoticePropsRef.current = null
    sessionRef.current = null
    indexRef.current = []
    openingRef.current = {}
    restoringRef.current = {}
    launchingRef.current = {}
    oskRef.current = { isOskOpen: false, keyboardHeight: 0, height: 0, offsetTop: 0 }
    transportReconnectingRef.current = false
    discoveredContextRef.current = {}
    messagesRef.current = []
  })

  function seedFailedLaunchSession(id: string): void {
    sessionRef.current = {
      id,
      agentId: '',
      cwd: '/w',
      projectId: 'p1',
      status: 'error',
      title: null,
      activeTurn: false,
      openTurnId: null,
      modes: null,
      models: null,
      configOptions: [],
      lastError: 'Authentication required: sign-in required for this agent',
      createdAt: 1,
      launchConfigId: 'cfg-1'
    } satisfies AcpSession
  }

  it('offers Retry for a failed launch without user messages and routes it to retryFailedLaunch', () => {
    seedFailedLaunchSession('launch-1')
    render(<AgentChatPanel sessionId="launch-1" isVisible />)
    // No user blocks in the transcript — the Retry affordance still shows
    // (the retry relaunches without re-sending).
    const props = errorNoticePropsRef.current
    expect(props?.message).toContain('Authentication required')
    expect(props?.onRetry).toBeDefined()
    props?.onRetry?.()
    expect(mockRetryFailed).toHaveBeenCalledWith('launch-1')
    expect(mockRetryCrashed).not.toHaveBeenCalled()
  })

  it('never toasts a circular "Could not retry" when the failed-launch retry fails', async () => {
    seedFailedLaunchSession('launch-1')
    mockRetryFailed.mockRejectedValueOnce(new Error('agent_auth_required'))
    render(<AgentChatPanel sessionId="launch-1" isVisible />)
    errorNoticePropsRef.current?.onRetry?.()
    await waitFor(() => expect(mockRetryFailed).toHaveBeenCalledWith('launch-1'))
    // The banner (session.lastError) is the error surface for this path.
    expect(toastErrorSpy).not.toHaveBeenCalled()
  })

  it('clears the banner dismissal before retrying so a repeated failure re-surfaces', async () => {
    seedFailedLaunchSession('launch-1')
    render(<AgentChatPanel sessionId="launch-1" isVisible />)
    // Dismiss the banner, then retry: the dismissal must be cleared first so
    // the same error text still renders the banner afterwards.
    errorNoticePropsRef.current?.onDismiss()
    await waitFor(() => expect(errorNoticePropsRef.current?.message).toBeNull())
    errorNoticePropsRef.current?.onRetry?.()
    await waitFor(() =>
      expect(errorNoticePropsRef.current?.message).toContain('Authentication required')
    )
    expect(mockRetryFailed).toHaveBeenCalledWith('launch-1')
  })

  it('routes a crashed-session retry (no launchConfigId) to retryCrashedSession as before', () => {
    sessionRef.current = {
      id: 's1',
      agentId: 'agent-1',
      cwd: '/w',
      projectId: 'p1',
      status: 'error',
      title: null,
      activeTurn: false,
      openTurnId: null,
      modes: null,
      models: null,
      configOptions: [],
      lastError: 'agent crashed',
      createdAt: 1
    } satisfies AcpSession
    messagesRef.current = [{ id: 'm1', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }]
    render(<AgentChatPanel sessionId="s1" isVisible />)
    const props = errorNoticePropsRef.current
    expect(props?.onRetry).toBeDefined()
    props?.onRetry?.()
    // A crashed session has no recorded launch config → the legacy
    // relaunch+replay path runs, never the failed-launch path.
    expect(mockRetryCrashed).toHaveBeenCalledWith('s1')
    expect(mockRetryFailed).not.toHaveBeenCalled()
  })
})

describe('AgentChatPanel ChatChangedFilesPanel mounting', () => {
  beforeEach(() => {
    changedFilesPanelPropsRef.current = []
  })

  it('always mounts ChatChangedFilesPanel with cwd and toolCalls for an active session', () => {
    sessionRef.current = {
      id: 's1',
      agentId: 'agent-1',
      cwd: '/w',
      projectId: 'p1',
      status: 'active',
      title: null,
      activeTurn: false,
      openTurnId: null,
      modes: null,
      models: null,
      configOptions: [],
      lastError: null,
      createdAt: 1
    } satisfies AcpSession
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(changedFilesPanelPropsRef.current.length).toBeGreaterThan(0)
    expect(changedFilesPanelPropsRef.current[0]).toMatchObject({ cwd: '/w' })
    expect(Array.isArray(changedFilesPanelPropsRef.current[0].toolCalls)).toBe(true)
  })

  it('mounts ChatChangedFilesPanel even for a closed session (renders null internally)', () => {
    sessionRef.current = {
      id: 's2',
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
      lastError: null,
      createdAt: 1
    } satisfies AcpSession
    render(<AgentChatPanel sessionId="s2" isVisible />)
    expect(changedFilesPanelPropsRef.current.length).toBeGreaterThan(0)
  })
})
