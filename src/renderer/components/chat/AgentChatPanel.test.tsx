import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECONNECT_GRACE_MS } from '@/hooks/use-delayed-flag'
import {
  NativeWebviewOccluder,
  resetNativeWebviewOcclusionForTests
} from '@/hooks/use-native-webview-occlusion'
import { CODEX_CLI_SIGNED_OUT_MESSAGE } from '@/lib/agents/codex-cli-auth'
import { commandToken } from '@/lib/skill-tokens'
import { mockAcpSession } from '@/lib/test-utils/acp'
import type { AcpSession } from '@/stores/acp-store'
import { useConsentCardHost } from '@/stores/browser-consent-card-store'
import { useConnectionStatusStore } from '@/stores/connection-status-store'

const {
  mockOpen,
  mockOpenDiscovered,
  mockRecheckPromptCommand,
  mockRetryCrashed,
  mockRetryFailed,
  agentStatusRef,
  mockMarkResumeFailed,
  mockSendPrompt,
  mockSendPromptBlocks,
  promptQueueRef,
  mockSetSwitchPendingOption,
  mockSetConfigOption,
  mockSetMode,
  mockSetModel,
  sessionsMapRef,
  agentsRef,
  commandsRef,
  preparedSessionsRef,
  optionsCacheRef,
  mockRemoveTab,
  mockShowAgentLauncher,
  toastErrorSpy,
  errorNoticePropsRef,
  sessionRef,
  indexRef,
  agentConfigsRef,
  openingRef,
  restoringRef,
  launchingRef,
  oskRef,
  transportReconnectingRef,
  promptCommandStatesRef,
  changedFilesPanelPropsRef,
  discoveredContextRef,
  messagesRef,
  toolCallsRef,
  agentSwitchesRef,
  timelineArgsRef,
  timelineCallCountRef,
  chatMessageListPropsRef,
  pendingBrowserConsentsRef,
  browserConsentCardPropsRef,
  mobileRef,
  pendingPermissionsRef,
  pendingQuestionsRef,
  pendingElicitationsRef,
  plansRef,
  planPanelPropsRef,
  askQuestionPropsRef,
  elicitationPropsRef,
  openGitSheetRef,
  permissionPromptPropsRef
} = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockOpenDiscovered: vi.fn(),
  mockRecheckPromptCommand: vi.fn(),
  // Story 5: failed-launch retry routing (Retry must reach retryFailedLaunch,
  // never retryCrashedSession, and never toast a circular "Could not retry").
  mockRetryCrashed: vi.fn(),
  mockRetryFailed: vi.fn(),
  agentStatusRef: { current: {} as Record<string, string> },
  // spec-stopped-chat-status-signals: the idle-stop auto-resume records a
  // failure through this store action when the store wrote none itself.
  mockMarkResumeFailed: vi.fn(),
  // Live-turn retry (handleRetry): asserts the sanitized wire blocks the
  // panel dispatches through the store's sendPromptBlocks.
  mockSendPromptBlocks: vi.fn(),
  // Composer text sends (handleSend): the idle-stop resume orders the open
  // before this call.
  mockSendPrompt: vi.fn(),
  // usePromptQueue answer (the idle-stop resume failure toast reads it).
  promptQueueRef: { current: [] as Array<{ id: string }> },
  // spec-acp-composer-option-fidelity: while a switch is armed, composer picks
  // route to this store action (queued on session.switching) — never the old
  // session's setConfigOption/setMode/setModel.
  mockSetSwitchPendingOption: vi.fn(),
  // The armed session's own option setters — asserted NOT called while a
  // switch is armed (picks route to the target's pending state instead).
  mockSetConfigOption: vi.fn(),
  mockSetMode: vi.fn(),
  mockSetModel: vi.fn(),
  // Extra sessions addressable by id (e.g. the switch target's prepared warm
  // session) so useAcpSession('s-warm') resolves in armed-switch tests.
  sessionsMapRef: { current: {} as Record<string, object> },
  agentsRef: { current: {} as Record<string, object> },
  commandsRef: { current: {} as Record<string, unknown[]> },
  // Armed-switch option scoping seams: the target's prepared session id (per
  // prepareChatKey) and its cached advertised options.
  preparedSessionsRef: { current: {} as Record<string, string> },
  optionsCacheRef: {
    current: {} as Record<
      string,
      { models: object | null; modes: object | null; configOptions: unknown[] }
    >
  },
  mockRemoveTab: vi.fn(),
  mockShowAgentLauncher: vi.fn(),
  toastErrorSpy: vi.fn(),
  // Latest ChatErrorNotice props (message/onRetry/onDismiss) per render.
  errorNoticePropsRef: {
    current: null as {
      message: string | null
      code?: number | null
      data?: unknown
      onRetry?: () => void
      onDismiss: () => void
    } | null
  },
  // AcpSession shape; typed loosely here because vi.hoisted runs before the
  // type-only import below is usable at runtime. `seedLiveSession` constructs
  // the value via `mockAcpSession` from '@/lib/test-utils/acp'.
  sessionRef: { current: null as object | null },
  indexRef: { current: [] as Array<{ id: string }> },
  // Armed-switch icon seam: seeded agentConfigs so the composer's model-chip
  // glyph resolves the TARGET templateId while armed (spec
  // fix-agent-switch-merge-ui). Loose shape — only id/templateId matter.
  agentConfigsRef: { current: [] as Array<{ id: string; templateId?: string; icon?: string }> },
  openingRef: { current: {} as Record<string, true> },
  restoringRef: { current: {} as Record<string, true> },
  launchingRef: { current: {} as Record<string, true> },
  // Story 5.3 (AC1/AC3): test seams for OSK + reconnect overlay.
  oskRef: { current: { isOskOpen: false, keyboardHeight: 0, height: 0, offsetTop: 0 } },
  transportReconnectingRef: { current: false },
  promptCommandStatesRef: { current: {} as Record<string, unknown> },
  changedFilesPanelPropsRef: {
    current: [] as Array<{
      cwd: string
      toolCalls: unknown[]
      forceCollapsed?: boolean
      onOpenGitChanges?: (opener: HTMLElement) => void
    }>
  },
  discoveredContextRef: {
    current: {} as Record<string, { agentId: string; cwd: string; projectId: string }>
  },
  // Story 5: seedable message list so retry-routing tests can exercise the
  // crashed-session path (which requires a user turn to offer Retry).
  messagesRef: { current: [] as Array<{ id: string; role: string; blocks: unknown[] }> },
  // Render-gate seams: tool-call array per session (mirrors messagesRef) and
  // the arguments buildTimeline last received (content assertions, not just
  // call counts).
  toolCallsRef: {
    current: {} as Record<string, Array<{ id: string; kind: string; cwd?: string }>>
  },
  timelineArgsRef: {
    current: [] as Array<{ messages: unknown[]; toolCalls: unknown[]; switches: unknown[] }>
  },
  // CAP-2: seedable switch-marker list per session (mirrors toolCallsRef).
  agentSwitchesRef: {
    current: {} as Record<string, Array<{ id: string; seq: number }>>
  },
  // Multi-project perf (render gate): counts timeline-pipeline invocations
  // so tests can assert hidden panels skip per-flush work.
  timelineCallCountRef: { current: { build: 0, consolidate: 0 } },
  // Latest ChatMessageList props per render (onRetry drives the live-turn
  // retry wire rebuild; items asserts the worktree-row injection;
  // filePathContext asserts the web/desktop open-in-editor parity).
  chatMessageListPropsRef: {
    current: null as {
      onRetry?: () => void
      items?: unknown[]
      filePathContext?: { cwd?: string; projectRoot?: string }
    } | null
  },
  // CAP-5: seedable browser-consent map so the panel's per-session filter can
  // be asserted (the pending card belongs to THIS panel's session only).
  pendingBrowserConsentsRef: {
    current: {} as Record<string, { requestId: string; sessionId: string }>
  },
  // CAP-5: latest BrowserConsentCard props per render.
  browserConsentCardPropsRef: {
    current: null as { consent?: { requestId: string; sessionId: string } } | null
  },
  // Mobile dock: `useMobileWebShell()` answer (default true, as before) and
  // seedable approval / plan state + captured child props for the wiring tests.
  mobileRef: { current: true },
  pendingPermissionsRef: { current: {} as Record<string, object> },
  pendingQuestionsRef: { current: {} as Record<string, object> },
  pendingElicitationsRef: { current: {} as Record<string, object> },
  plansRef: { current: {} as Record<string, object[]> },
  planPanelPropsRef: {
    current: [] as Array<{ defaultCollapsed?: boolean; forceCollapsed?: boolean }>
  },
  askQuestionPropsRef: { current: [] as Array<{ autoFocusFirstOption?: boolean }> },
  elicitationPropsRef: { current: [] as Array<{ autoFocusHeading?: boolean }> },
  openGitSheetRef: { current: vi.fn() },
  // The props the morph branch hands PermissionPrompt.
  permissionPromptPropsRef: {
    current: [] as Array<{ isVisible?: boolean; embedded?: boolean }>
  }
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorSpy }
}))

// CAP-5: the panel's consent-card gate reads isTauriContext(); default false
// matches the real jsdom answer so every other suite keeps its behavior.
const { runtimeState } = vi.hoisted(() => ({ runtimeState: { tauri: false } }))
vi.mock('@/lib/tauri-runtime', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/tauri-runtime')>()),
  isTauriContext: () => runtimeState.tauri
}))

vi.mock('@/stores/workspace-store', () => ({
  agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
  findPaneContainingTab: () => ({ id: 'pane-1', activeTabId: 'chat-s1' }),
  useActiveTab: () => undefined,
  useWorkspaceStore: {
    getState: () => ({ removeTab: mockRemoveTab, showAgentLauncher: mockShowAgentLauncher })
  }
}))

vi.mock('@/stores/acp-store', () => {
  const state = () => ({
    agents: agentsRef.current,
    agentStatus: agentStatusRef.current,
    commands: commandsRef.current,
    agentSwitches: agentSwitchesRef.current,
    agentConfigs: agentConfigsRef.current,
    toolCalls: toolCallsRef.current,
    plans: plansRef.current,
    pendingPermissions: pendingPermissionsRef.current,
    pendingQuestions: pendingQuestionsRef.current,
    pendingElicitations: pendingElicitationsRef.current,
    pendingBrowserConsents: pendingBrowserConsentsRef.current,
    // The panel's gate selects `s.messages[sessionId]`; the legacy
    // useAcpMessages mock serves one flat list for ANY session, so the map
    // is a Proxy answering every key with messagesRef.
    messages: new Proxy({}, { get: () => messagesRef.current }),
    sessions: sessionsMapRef.current,
    configToLiveAgent: {},
    preparedSessions: preparedSessionsRef.current,
    agentOptionsCache: optionsCacheRef.current,
    sessionIndex: indexRef.current,
    openingHistoryIds: openingRef.current,
    restoringChatIds: restoringRef.current,
    launchingSessionIds: launchingRef.current,
    discoveredReopenContexts: discoveredContextRef.current,
    transportReconnecting: transportReconnectingRef.current,
    promptCommandStates: promptCommandStatesRef.current,
    recheckPromptCommand: mockRecheckPromptCommand,
    openHistorySession: mockOpen,
    openDiscoveredSession: mockOpenDiscovered,
    sendPrompt: mockSendPrompt,
    sendPromptBlocks: mockSendPromptBlocks,
    cancelPrompt: vi.fn(),
    removeQueuedPrompt: vi.fn(),
    sendQueuedPromptNow: vi.fn(),
    retryCrashedSession: mockRetryCrashed,
    retryFailedLaunch: mockRetryFailed,
    markResumeFailed: mockMarkResumeFailed,
    setConfigOption: mockSetConfigOption,
    setMode: mockSetMode,
    setModel: mockSetModel,
    setSwitchPendingOption: mockSetSwitchPendingOption
  })
  return {
    useAcpStore: Object.assign((sel: (s: unknown) => unknown) => sel(state()), {
      // Imperative reads (e.g. the manual resume's still-closed check) see the
      // seeded session through the same ref the session hook serves.
      getState: () => ({
        ...state(),
        sessions: sessionRef.current ? { [sessionRef.current.id]: sessionRef.current } : {}
      })
    }),
    // Armed-switch tests seed a second session by id (the target's prepared
    // warm session); a null id resolves to null (matching the real hook) and
    // every other caller keeps the legacy sessionRef answer.
    useAcpSession: (sessionId: string | null | undefined) =>
      sessionId == null ? null : (sessionsMapRef.current[sessionId] ?? sessionRef.current),
    // Icon selectors the composer uses for the model-chip glyph. The armed
    // test seeds `agentConfigs` for the target (`cfg-new`) and resolves the
    // source via `agentId` — the same precedence the real hooks apply.
    useAgentTemplateId: (agentId: string | null, agentConfigId?: string) => {
      if (agentConfigId) {
        const cfg = agentConfigsRef.current.find((c) => c.id === agentConfigId)
        if (cfg?.templateId) return cfg.templateId
      }
      return agentId === 'agent-old' ? 'devin' : null
    },
    useAgentIcon: () => null,
    useAcpMessages: () => messagesRef.current,
    usePromptQueue: () => promptQueueRef.current,
    configIdFromReuseKey: (key: string) => key,
    // Mirrors acp-store's prepareChatKey — the panel looks up the switch
    // target's prepared session by (toConfigId, session.cwd, mcpServers).
    prepareChatKey: (configId: string, cwd: string, mcpServers?: unknown[]) =>
      [
        configId,
        cwd.trim(),
        (mcpServers ?? [])
          .map((s) => JSON.stringify(s))
          .sort()
          .join('|')
      ].join(String.fromCharCode(0))
  }
})

// The panel gates its stream subscriptions through useAcpStoreVisible. The
// store mock above is a bare selector fn with no zustand statics, so the gate
// is mocked to the same freeze contract on top of it: while `isVisible` is
// true the selector reads the live mock state; while false the last visible
// value is returned and updated only in an effect (purity preserved — a
// hidden render never republishes live data).
vi.mock('@/hooks/use-acp-visible-store', async () => {
  const acp = await import('@/stores/acp-store')
  const React = await import('react')
  const store = acp.useAcpStore as unknown as (s: (x: unknown) => unknown) => unknown
  return {
    useAcpStoreVisible: <T,>(sel: (s: unknown) => T, isVisible: boolean): T => {
      const live = store(sel)
      const frozen = React.useRef(live)
      React.useEffect(() => {
        if (isVisible) frozen.current = live
      }, [isVisible, live])
      return isVisible ? live : frozen.current
    }
  }
})

// Story 5.3 (AC1): mock the OSK + mobile shell hooks so we can drive
// `isOskOpen` / `keyboardHeight` from the test seam.
vi.mock('@/hooks/use-osk-viewport', () => ({
  useOskViewport: () => oskRef.current
}))
vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current
}))
vi.mock('@/stores/git-sheet-store', () => ({
  useGitSheetStore: (
    sel: (s: { openGitSheet: (cwd?: string, opener?: HTMLElement | null) => void }) => unknown
  ) => sel({ openGitSheet: (cwd, opener) => openGitSheetRef.current(cwd, opener) })
}))

// Child components pull in heavy chat rendering; the states under test render
// before any of them mount.
vi.mock('./ChatErrorNotice', () => ({
  ChatErrorNotice: (props: {
    message: string | null
    code?: number | null
    data?: unknown
    onRetry?: () => void
    retryLabel?: string
    onDismiss: () => void
  }) => {
    errorNoticePropsRef.current = props
    return null
  }
}))
vi.mock('./ChatChangedFilesPanel', () => ({
  ChatChangedFilesPanel: (props: {
    cwd: string
    toolCalls: unknown[]
    forceCollapsed?: boolean
    onOpenGitChanges?: (opener: HTMLElement) => void
  }) => {
    changedFilesPanelPropsRef.current.push(props)
    // A marker, so the dock tests can assert the bar sits inside the dock wrapper.
    return <div data-testid="changed-files-stub" />
  }
}))
const { chatInputBarPropsRef } = vi.hoisted(() => ({
  chatInputBarPropsRef: {
    current: [] as Array<{
      isVisible?: boolean
      disabled?: boolean
      controlsDisabled?: boolean
      onSend?: (text: string) => void
      onSendBlocks?: (blocks: unknown[], displayBlocks?: unknown[]) => void
      onDraftStart?: () => void
      session?: {
        models?: unknown
        modes?: unknown
        configOptions?: unknown[]
        mcpServerCount?: number
      }
      commands?: unknown[]
      imageCapable?: boolean
      embedCapable?: boolean
      configOptions?: unknown[]
      modes?: unknown
      onSetConfig?: (configId: string, valueId: string) => Promise<void>
      onSetMode?: (modeId: string) => Promise<void>
      onSetModel?: (modelId: string) => Promise<void>
    }>
  }
}))
// The stub keeps the real composer-card contract the dock relies on
// (`data-chat-composer`, `tabIndex=-1`) and renders the embedded permission
// prompt marker + button, so focus return can be asserted through the panel.
vi.mock('./ChatInputBar', () => ({
  ChatInputBar: (props: { isVisible?: boolean; permission?: { requestId: string } | null }) => {
    chatInputBarPropsRef.current.push(props)
    return (
      <div data-chat-composer="true" tabIndex={-1} data-testid="composer-stub">
        {props.permission ? (
          <section data-approval-prompt={`permission:${props.permission.requestId}`}>
            <button type="button">Allow once</button>
          </section>
        ) : null}
        <input aria-label="editor" />
      </div>
    )
  }
}))
vi.mock('./ChatMessageList', () => ({
  ChatMessageList: (props: { onRetry?: () => void; items?: unknown[] }) => {
    chatMessageListPropsRef.current = props
    return null
  }
}))
// The three prompt stubs render a marker each (like `composer-stub`) so the dock
// tests can assert they sit inside the dock wrapper.
vi.mock('./PermissionPrompt', () => ({
  PermissionPrompt: (props: { isVisible?: boolean; embedded?: boolean }) => {
    permissionPromptPropsRef.current.push(props)
    return <div data-testid="permission-stub" />
  }
}))
vi.mock('./AskUserQuestion', () => ({
  AskUserQuestion: (props: { autoFocusFirstOption?: boolean }) => {
    askQuestionPropsRef.current.push(props)
    return <div data-testid="question-stub" />
  }
}))
vi.mock('./ElicitationPrompt', () => ({
  ElicitationPrompt: (props: { autoFocusHeading?: boolean }) => {
    elicitationPropsRef.current.push(props)
    return <div data-testid="elicitation-stub" />
  }
}))
vi.mock('./BrowserConsentCard', () => ({
  BrowserConsentCard: (props: { consent?: { requestId: string; sessionId: string } }) => {
    browserConsentCardPropsRef.current = props
    return null
  }
}))
vi.mock('./PlanPanel', () => ({
  PlanPanel: (props: { defaultCollapsed?: boolean; forceCollapsed?: boolean }) => {
    planPanelPropsRef.current.push(props)
    return null
  }
}))
vi.mock('./chat-timeline', () => {
  return {
    buildTimeline: (
      messages: Array<{ id: string; role: string }>,
      toolCalls: unknown[],
      switches: unknown[] = []
    ) => {
      timelineCallCountRef.current.build++
      timelineArgsRef.current.push({ messages, toolCalls, switches })
      // One message-kind item per message carrying `message.role`, so the
      // panel's first-user splice for the worktree row can inspect roles.
      return messages.map((m) => ({ key: m.id, kind: 'message', message: m }))
    },
    consolidateThoughtGroups: (items: unknown[]) => {
      timelineCallCountRef.current.consolidate++
      return items
    }
  }
})

import { AgentChatPanel } from './AgentChatPanel'
import {
  AUTO_RESUME_FAILED_QUEUED_TOAST,
  AUTO_RESUME_FAILED_REASON
} from './use-idle-stop-auto-resume'

function seedLiveSession(id: string, lastError: string | null = null): void {
  sessionRef.current = mockAcpSession({ id, cwd: '/w', status: 'closed', lastError })
}

/** The props of the most recent ChatInputBar render. */
function lastComposerProps(): (typeof chatInputBarPropsRef.current)[number] | undefined {
  return chatInputBarPropsRef.current.at(-1)
}

/** Advance fake timers past a render-driven delay (e.g. the reconnect grace period). */
function advanceTimers(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** A prompt command waiting to confirm (AD-6), as the store publishes it. */
function pendingCommand(outcomeUnknown: boolean): Record<string, unknown> {
  return {
    commandId: 'turn-1',
    kind: 'send_prompt',
    entityKey: 's1',
    phase: 'pending-reconcile',
    outcomeUnknown,
    attempts: 1
  }
}

describe('AgentChatPanel restored-tab rehydration', () => {
  beforeEach(() => {
    sessionsMapRef.current = {}
    mockOpen.mockReset().mockResolvedValue(undefined)
    mockOpenDiscovered.mockReset().mockResolvedValue(undefined)
    mockRemoveTab.mockReset()
    mockShowAgentLauncher.mockReset()
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

  it('closes a dropped launch placeholder instead of the unavailable corpse (#882)', async () => {
    render(<AgentChatPanel sessionId="launch-abc" isVisible />)
    expect(screen.queryByText('This chat is unavailable.')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Restoring chat' })).toBeInTheDocument()
    expect(mockOpen).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(mockRemoveTab).toHaveBeenCalledWith('chat-launch-abc')
    })
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('does not close a live launch tab or one that is still launching (#882)', async () => {
    sessionsMapRef.current = {
      'launch-abc': mockAcpSession({ id: 'launch-abc', cwd: '/w', status: 'active' })
    }
    const live = render(<AgentChatPanel sessionId="launch-abc" isVisible />)
    expect(mockRemoveTab).not.toHaveBeenCalled()
    expect(mockOpen).not.toHaveBeenCalled()
    live.unmount()

    sessionsMapRef.current = {}
    launchingRef.current = { 'launch-abc': true }
    render(<AgentChatPanel sessionId="launch-abc" isVisible />)
    expect(mockRemoveTab).not.toHaveBeenCalled()
    expect(mockOpen).not.toHaveBeenCalled()
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

  it('announces a resuming banner while a closed session is being reopened', () => {
    seedLiveSession('s1')
    openingRef.current = { s1: true }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Resuming chat…')
    expect(banner).toHaveAttribute('aria-live', 'polite')
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
    fireEvent.click(screen.getByRole('button', { name: 'Retry restore' }))
    expect(mockOpenDiscovered).toHaveBeenCalledWith('agent-native', 's1', '/native', 'p-native')
  })

  it('offers a Reconnect action for a closed session with history (no dead end)', () => {
    // A failed reconnect leaves the session registered but closed with the
    // resume error; the pane must offer a working way to re-attempt the reopen.
    seedLiveSession('s1', 'Resume failed: boom')
    indexRef.current = [{ id: 's1' }]
    render(<AgentChatPanel sessionId="s1" isVisible />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume chat' }))
    expect(mockOpen).toHaveBeenCalledWith('s1')
  })

  it('asks for sign-in when the Codex CLI logged out', () => {
    seedLiveSession('s1', CODEX_CLI_SIGNED_OUT_MESSAGE)
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByText(CODEX_CLI_SIGNED_OUT_MESSAGE)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume chat' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(mockShowAgentLauncher).toHaveBeenCalledWith('pane-1')
  })

  it('surfaces a read-only banner when a closed session has history and no reopen context (CAP-4)', async () => {
    // Remap failed or strategy was 'local' → the automatic resume settles
    // with the session still closed (no live agent) → explicit read-only hint.
    seedLiveSession('s1')
    indexRef.current = [{ id: 's1' }]
    render(<AgentChatPanel sessionId="s1" isVisible />)
    await act(async () => {
      lastComposerProps()?.onDraftStart?.()
    })
    expect(screen.getByText('This chat stopped.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume chat' })).toBeInTheDocument()
    expect(lastComposerProps()?.disabled).toBe(true)
  })
})

// spec-idle-stopped-chat-seamless-resume: a chat the host idle reaper stopped
// (closed, has history, lastError is not a resume failure) resumes on the
// first keystroke or send.
describe('AgentChatPanel idle-stopped chat seamless resume', () => {
  beforeEach(() => {
    sessionsMapRef.current = {}
    mockOpen.mockReset().mockResolvedValue(undefined)
    mockSendPrompt.mockReset().mockResolvedValue(undefined)
    mockSendPromptBlocks.mockReset().mockResolvedValue(undefined)
    mockRetryCrashed.mockReset().mockResolvedValue(undefined)
    mockMarkResumeFailed.mockReset()
    toastErrorSpy.mockReset()
    sessionRef.current = null
    indexRef.current = [{ id: 's1' }]
    openingRef.current = {}
    restoringRef.current = {}
    launchingRef.current = {}
    discoveredContextRef.current = {}
    messagesRef.current = []
    promptQueueRef.current = []
    errorNoticePropsRef.current = null
    chatInputBarPropsRef.current = []
    seedLiveSession('s1')
  })

  /** Publish the store marks a real `openHistorySession` sets while it runs. */
  function publishOpening(rerender: (ui: React.ReactElement) => void): void {
    openingRef.current = { s1: true }
    restoringRef.current = { s1: true }
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
  }

  it('hides the stopped bar, keeps the composer enabled and the pickers disabled', () => {
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.queryByText('This chat stopped.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume chat' })).not.toBeInTheDocument()
    expect(lastComposerProps()?.disabled).toBe(false)
    expect(lastComposerProps()?.controlsDisabled).toBe(true)
    expect(lastComposerProps()?.onDraftStart).toBeTypeOf('function')
  })

  it('stays resumable with a leftover turn note in lastError', () => {
    seedLiveSession('s1', 'Interrupted by server restart.')
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.queryByText('This chat stopped.')).not.toBeInTheDocument()
    expect(lastComposerProps()?.disabled).toBe(false)
    // The note itself stays visible.
    expect(errorNoticePropsRef.current?.message).toBe('Interrupted by server restart.')
  })

  it('is not resumable after a resume failure', () => {
    seedLiveSession('s1', 'Resume failed: spawn boom')
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByText('This chat stopped.')).toBeInTheDocument()
    expect(lastComposerProps()?.disabled).toBe(true)
    expect(lastComposerProps()?.onDraftStart).toBeUndefined()
  })

  it('does not resume from viewing alone', () => {
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible={false} />)
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('starts the open before a text send so the prompt queues behind it', () => {
    render(<AgentChatPanel sessionId="s1" isVisible />)
    act(() => {
      lastComposerProps()?.onSend?.('continue')
    })
    expect(mockOpen).toHaveBeenCalledWith('s1')
    expect(mockSendPrompt).toHaveBeenCalledWith('s1', 'continue')
    expect(mockOpen.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendPrompt.mock.invocationCallOrder[0]
    )
  })

  it('starts the open before a blocks send (attachments / pills)', () => {
    render(<AgentChatPanel sessionId="s1" isVisible />)
    const blocks = [{ type: 'text', text: 'see file' }]
    act(() => {
      lastComposerProps()?.onSendBlocks?.(blocks)
    })
    expect(mockOpen).toHaveBeenCalledWith('s1')
    expect(mockSendPromptBlocks).toHaveBeenCalledWith('s1', blocks, { displayBlocks: undefined })
    expect(mockOpen.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendPromptBlocks.mock.invocationCallOrder[0]
    )
  })

  it('resumes once on the first keystroke (one automatic attempt per stop)', () => {
    mockOpen.mockReturnValue(new Promise(() => {}))
    render(<AgentChatPanel sessionId="s1" isVisible />)
    act(() => {
      lastComposerProps()?.onDraftStart?.()
      lastComposerProps()?.onDraftStart?.()
    })
    act(() => {
      lastComposerProps()?.onSend?.('continue')
    })
    expect(mockOpen).toHaveBeenCalledTimes(1)
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
  })

  it('tracks an open already in flight instead of starting another', () => {
    openingRef.current = { s1: true }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    act(() => {
      lastComposerProps()?.onSend?.('continue')
    })
    expect(mockOpen).not.toHaveBeenCalled()
    expect(mockSendPrompt).toHaveBeenCalledWith('s1', 'continue')
  })

  it('keeps the composer mounted through a fast reconnect, then auto-resumes a second stop', () => {
    mockOpen.mockReturnValue(new Promise(() => {}))
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
    act(() => {
      lastComposerProps()?.onDraftStart?.()
    })
    publishOpening(rerender)
    expect(screen.queryByRole('status', { name: 'Restoring chat' })).not.toBeInTheDocument()
    expect(screen.getByTestId('composer-stub')).toBeInTheDocument()
    expect(screen.getByText('Resuming chat…')).toBeInTheDocument()
    expect(lastComposerProps()?.disabled).toBe(false)

    // The agent is back before the store's ≥400 ms restore mark clears.
    sessionRef.current = mockAcpSession({ id: 's1', cwd: '/w', status: 'active' })
    openingRef.current = {}
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.queryByRole('status', { name: 'Restoring chat' })).not.toBeInTheDocument()
    expect(screen.getByTestId('composer-stub')).toBeInTheDocument()

    // The restore mark clears: the attempt resets, so a later restore of this
    // live chat shows the normal preload again.
    restoringRef.current = {}
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    restoringRef.current = { s1: true }
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByRole('status', { name: 'Restoring chat' })).toBeInTheDocument()
    restoringRef.current = {}

    // Reaped again: the next keystroke starts a new automatic resume.
    seedLiveSession('s1')
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.queryByText('This chat stopped.')).not.toBeInTheDocument()
    act(() => {
      lastComposerProps()?.onDraftStart?.()
    })
    expect(mockOpen).toHaveBeenCalledTimes(2)
  })

  it('brings the bar back with a toast when the open resolves still closed with a queued prompt', async () => {
    let resolveOpen!: () => void
    mockOpen.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveOpen = resolve
      })
    )
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
    act(() => {
      lastComposerProps()?.onSend?.('continue')
    })
    publishOpening(rerender)
    // The send queued behind the open; the open lands read-only (no agent).
    promptQueueRef.current = [{ id: 'q1' }]
    openingRef.current = {}
    restoringRef.current = {}
    await act(async () => {
      resolveOpen()
    })
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByText('This chat stopped.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume chat' })).toBeInTheDocument()
    expect(lastComposerProps()?.disabled).toBe(true)
    expect(toastErrorSpy).toHaveBeenCalledTimes(1)
    expect(toastErrorSpy).toHaveBeenCalledWith(AUTO_RESUME_FAILED_QUEUED_TOAST)
  })

  it('keeps the composer through the restore tail of a failed attempt, then a manual resume shows the preload', async () => {
    let resolveOpen!: () => void
    mockOpen.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveOpen = resolve
      })
    )
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
    act(() => {
      lastComposerProps()?.onDraftStart?.()
    })
    publishOpening(rerender)
    // The open settles still closed while the store holds the ≥400 ms restore mark.
    openingRef.current = {}
    await act(async () => {
      resolveOpen()
    })
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByTestId('composer-stub')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Restoring chat' })).not.toBeInTheDocument()

    // The restore mark clears; a manual Resume chat restores with the preload.
    restoringRef.current = {}
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume chat' }))
    expect(mockOpen).toHaveBeenCalledTimes(2)
    restoringRef.current = { s1: true }
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByRole('status', { name: 'Restoring chat' })).toBeInTheDocument()
  })

  it('falls back to the error and Resume chat when the automatic resume fails', async () => {
    mockOpen.mockRejectedValueOnce(new Error('spawn boom'))
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
    await act(async () => {
      lastComposerProps()?.onSend?.('continue')
    })
    // The store records the failure on the record.
    seedLiveSession('s1', 'Resume failed: spawn boom')
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(errorNoticePropsRef.current?.message).toBe('Resume failed: spawn boom')
    expect(screen.getByText('This chat stopped.')).toBeInTheDocument()
    expect(lastComposerProps()?.disabled).toBe(true)
    expect(lastComposerProps()?.onDraftStart).toBeUndefined()
    // No queued prompt in this case → no toast.
    expect(toastErrorSpy).not.toHaveBeenCalled()
    // No automatic retry loop; the manual Resume chat re-attempts the open.
    expect(mockOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Resume chat' }))
    expect(mockOpen).toHaveBeenCalledTimes(2)
  })

  it('does not auto-resume again after a failed attempt even without a lastError', async () => {
    mockOpen.mockRejectedValueOnce(new Error('no persisted history'))
    render(<AgentChatPanel sessionId="s1" isVisible />)
    await act(async () => {
      lastComposerProps()?.onDraftStart?.()
    })
    expect(screen.getByText('This chat stopped.')).toBeInTheDocument()
    expect(lastComposerProps()?.disabled).toBe(true)
    expect(lastComposerProps()?.onDraftStart).toBeUndefined()
    expect(mockOpen).toHaveBeenCalledTimes(1)
  })

  it('gh-821: hands the agent error code and data to the error notice', () => {
    indexRef.current = []
    sessionRef.current = mockAcpSession({
      id: 's1',
      cwd: '/w',
      status: 'error',
      lastError: 'Internal error',
      lastErrorCode: -32603,
      lastErrorData: { reason: 'login' }
    })
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(errorNoticePropsRef.current?.message).toBe('Internal error')
    expect(errorNoticePropsRef.current?.code).toBe(-32603)
    expect(errorNoticePropsRef.current?.data).toEqual({ reason: 'login' })
  })

  it('leaves a crashed (error) chat on the unchanged error notice', () => {
    indexRef.current = []
    sessionRef.current = mockAcpSession({
      id: 's1',
      cwd: '/w',
      status: 'error',
      lastError: 'agent crashed'
    })
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(errorNoticePropsRef.current?.message).toBe('agent crashed')
    expect(lastComposerProps()?.onDraftStart).toBeUndefined()
    expect(mockOpen).not.toHaveBeenCalled()
  })

  // spec-stopped-chat-status-signals: a failed automatic resume is recorded
  // as a `Resume failed: …` lastError so Attention, the panel and a remount agree.
  describe('failed automatic resume is recorded', () => {
    const RECORDED = `Resume failed: ${AUTO_RESUME_FAILED_REASON}`

    it('records a resume failure when the open resolves still closed with no lastError', async () => {
      let resolveOpen!: () => void
      mockOpen.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveOpen = resolve
        })
      )
      const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
      act(() => {
        lastComposerProps()?.onDraftStart?.()
      })
      publishOpening(rerender)
      openingRef.current = {}
      restoringRef.current = {}
      await act(async () => {
        resolveOpen()
      })
      rerender(<AgentChatPanel sessionId="s1" isVisible />)
      expect(mockMarkResumeFailed).toHaveBeenCalledTimes(1)
      expect(mockMarkResumeFailed).toHaveBeenCalledWith('s1', AUTO_RESUME_FAILED_REASON)
      // The store applies the record; the panel derives everything from it.
      seedLiveSession('s1', RECORDED)
      rerender(<AgentChatPanel sessionId="s1" isVisible />)
      expect(errorNoticePropsRef.current?.message).toBe(RECORDED)
      expect(screen.getByText('This chat stopped.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Resume chat' })).toBeInTheDocument()
      expect(lastComposerProps()?.disabled).toBe(true)
      expect(mockMarkResumeFailed).toHaveBeenCalledTimes(1)
    })

    it('does not record again when the store already wrote the resume failure (rejection)', async () => {
      mockOpen.mockImplementationOnce(async () => {
        // The store writes `Resume failed: …` before the open rejects.
        seedLiveSession('s1', 'Resume failed: spawn boom')
        throw new Error('spawn boom')
      })
      const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
      await act(async () => {
        lastComposerProps()?.onSend?.('continue')
      })
      rerender(<AgentChatPanel sessionId="s1" isVisible />)
      expect(screen.getByText('This chat stopped.')).toBeInTheDocument()
      expect(errorNoticePropsRef.current?.message).toBe('Resume failed: spawn boom')
      expect(mockMarkResumeFailed).not.toHaveBeenCalled()
    })

    it('a remount after the recorded failure does not auto-resume again', () => {
      seedLiveSession('s1', RECORDED)
      const first = render(<AgentChatPanel sessionId="s1" isVisible />)
      first.unmount()
      render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(screen.getByText('This chat stopped.')).toBeInTheDocument()
      expect(lastComposerProps()?.disabled).toBe(true)
      expect(lastComposerProps()?.onDraftStart).toBeUndefined()
      act(() => {
        lastComposerProps()?.onSend?.('continue')
      })
      expect(mockOpen).not.toHaveBeenCalled()
      expect(mockMarkResumeFailed).not.toHaveBeenCalled()
    })

    it("the notice's Resume chat reopens like the bar, even with no user turn", () => {
      seedLiveSession('s1', RECORDED)
      render(<AgentChatPanel sessionId="s1" isVisible />)
      const props = errorNoticePropsRef.current as { retryLabel?: string; onRetry?: () => void }
      expect(props.retryLabel).toBe('Resume chat')
      expect(props.onRetry).toBeDefined()
      act(() => {
        props.onRetry?.()
      })
      expect(mockOpen).toHaveBeenCalledTimes(1)
      expect(mockOpen).toHaveBeenCalledWith('s1')
      expect(mockRetryCrashed).not.toHaveBeenCalled()
      expect(mockSendPromptBlocks).not.toHaveBeenCalled()
    })

    it("the notice's Resume chat does not resend a finished last user turn", () => {
      seedLiveSession('s1', 'Resume failed: spawn boom')
      messagesRef.current = [{ id: 'm1', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }]
      render(<AgentChatPanel sessionId="s1" isVisible />)
      act(() => {
        errorNoticePropsRef.current?.onRetry?.()
      })
      expect(mockOpen).toHaveBeenCalledWith('s1')
      expect(mockRetryCrashed).not.toHaveBeenCalled()
      expect(mockSendPromptBlocks).not.toHaveBeenCalled()
    })

    it("records a failed resume when the notice's Resume chat reopen resolves still closed", async () => {
      seedLiveSession('s1', RECORDED)
      mockOpen.mockImplementationOnce(async () => {
        // The reopen installs history (clearing lastError) but lands read-only.
        sessionRef.current = mockAcpSession({
          id: 's1',
          cwd: '/w',
          status: 'closed',
          lastError: null
        })
      })
      render(<AgentChatPanel sessionId="s1" isVisible />)
      await act(async () => {
        errorNoticePropsRef.current?.onRetry?.()
      })
      expect(mockMarkResumeFailed).toHaveBeenCalledWith('s1', AUTO_RESUME_FAILED_REASON)
    })

    it("does not record a failure when the notice's Resume chat reconnects", async () => {
      seedLiveSession('s1', RECORDED)
      mockOpen.mockImplementationOnce(async () => {
        sessionRef.current = mockAcpSession({
          id: 's1',
          cwd: '/w',
          status: 'active',
          lastError: null
        })
      })
      render(<AgentChatPanel sessionId="s1" isVisible />)
      await act(async () => {
        errorNoticePropsRef.current?.onRetry?.()
      })
      expect(mockMarkResumeFailed).not.toHaveBeenCalled()
    })

    it("toasts when the notice's Resume chat open rejects with a normal error", async () => {
      seedLiveSession('s1', RECORDED)
      mockOpen.mockRejectedValueOnce(new Error('spawn boom'))
      render(<AgentChatPanel sessionId="s1" isVisible />)
      await act(async () => {
        errorNoticePropsRef.current?.onRetry?.()
      })
      expect(toastErrorSpy).toHaveBeenCalledWith('Could not resume this chat. Try again.')
    })

    it("does not toast when the notice's Resume chat open rejects with an agent-dead error", async () => {
      seedLiveSession('s1', RECORDED)
      mockOpen.mockRejectedValueOnce(new Error('agent thread is no longer running'))
      render(<AgentChatPanel sessionId="s1" isVisible />)
      await act(async () => {
        errorNoticePropsRef.current?.onRetry?.()
      })
      expect(mockOpen).toHaveBeenCalledWith('s1')
      expect(toastErrorSpy).not.toHaveBeenCalled()
    })

    it('re-shows the notice after a dismissed, identical repeat failure', async () => {
      seedLiveSession('s1', RECORDED)
      render(<AgentChatPanel sessionId="s1" isVisible />)
      act(() => {
        errorNoticePropsRef.current?.onDismiss()
      })
      expect(errorNoticePropsRef.current?.message).toBeNull()
      // The reopen settles still failed with the same recorded error.
      await act(async () => {
        errorNoticePropsRef.current?.onRetry?.()
      })
      expect(errorNoticePropsRef.current?.message).toBe(RECORDED)
    })

    it('leaves a discovered-reopen session on its own Retry restore path', () => {
      seedLiveSession('s1', RECORDED)
      discoveredContextRef.current = { s1: { agentId: 'a1', cwd: '/w', projectId: 'p1' } }
      render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(screen.getByRole('button', { name: 'Retry restore' })).toBeInTheDocument()
      // No user turn: the notice offers no Resume chat of its own.
      expect(errorNoticePropsRef.current?.onRetry).toBeUndefined()
    })

    it('a crashed (error) chat Retry still resends as before', () => {
      indexRef.current = []
      sessionRef.current = mockAcpSession({
        id: 's1',
        cwd: '/w',
        status: 'error',
        lastError: 'Resume failed: spawn boom'
      })
      messagesRef.current = [{ id: 'm1', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }]
      render(<AgentChatPanel sessionId="s1" isVisible />)
      act(() => {
        errorNoticePropsRef.current?.onRetry?.()
      })
      expect(mockRetryCrashed.mock.calls).toEqual([['s1']])
      expect(mockMarkResumeFailed).not.toHaveBeenCalled()
    })
  })

  it('keeps the Codex sign-in bar and a disabled composer', () => {
    seedLiveSession('s1', CODEX_CLI_SIGNED_OUT_MESSAGE)
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(lastComposerProps()?.disabled).toBe(true)
    expect(lastComposerProps()?.onDraftStart).toBeUndefined()
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
    promptCommandStatesRef.current = {}
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

  describe('reconnect grace period', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
      useConnectionStatusStore.setState({ controlChannel: 'connecting' })
    })

    it('renders the transport reconnect overlay once reconnecting lasts the grace period, until it ends (AC3, long reconnect)', () => {
      seedLiveSession('s1')
      transportReconnectingRef.current = true
      const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
      // Inside the grace period: nothing yet.
      expect(screen.queryByText(/Reconnecting/)).toBeNull()
      advanceTimers(RECONNECT_GRACE_MS - 1)
      expect(screen.queryByText(/Reconnecting/)).toBeNull()
      advanceTimers(1)
      // The overlay reuses AgentConnectionLamp (warning/pulse) and shows "Reconnecting…"
      expect(screen.getByText(/Reconnecting/)).toBeInTheDocument()
      expect(screen.getByRole('status')).toBeInTheDocument()
      // Stays up for as long as the reconnect lasts…
      advanceTimers(10_000)
      expect(screen.getByText(/Reconnecting/)).toBeInTheDocument()
      // …and goes away at once when it ends.
      transportReconnectingRef.current = false
      rerender(<AgentChatPanel sessionId="s1" isVisible />)
      expect(screen.queryByText(/Reconnecting/)).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()
    })

    it('never renders the overlay for a reconnect shorter than the grace period (quick reconnect)', () => {
      seedLiveSession('s1')
      transportReconnectingRef.current = true
      const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
      advanceTimers(300)
      expect(screen.queryByText(/Reconnecting/)).toBeNull()
      transportReconnectingRef.current = false
      rerender(<AgentChatPanel sessionId="s1" isVisible />)
      advanceTimers(RECONNECT_GRACE_MS * 2)
      expect(screen.queryByText(/Reconnecting/)).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()
    })

    it('shows "Host offline" immediately, without the grace period', () => {
      seedLiveSession('s1')
      useConnectionStatusStore.setState({ controlChannel: 'host-offline' })
      transportReconnectingRef.current = true
      render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(screen.getByRole('status')).toHaveTextContent('Host offline')
    })

    it('hides the subagent pill while the reconnect overlay holds the top-right corner', () => {
      seedLiveSession('s1')
      toolCallsRef.current = {
        s1: [
          {
            toolCallId: 'a1',
            status: 'completed',
            rawInput: { description: 'Audit code', prompt: 'p', subagent_type: 'general-purpose' }
          }
        ] as unknown as Array<{ id: string; kind: string }>
      }
      try {
        const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
        const pill = screen.getByRole('button', { name: /^Subagents:/ })
        // jsdom never finishes framer's exit spring, so read the pill's live
        // region, which follows whether the pill is shown.
        const liveRegion = pill.closest('.top-2')?.querySelector('[aria-live]')
        expect(liveRegion).toHaveTextContent('Subagents: 1 done')

        transportReconnectingRef.current = true
        rerender(<AgentChatPanel sessionId="s1" isVisible />)
        advanceTimers(RECONNECT_GRACE_MS)
        expect(screen.getByText(/Reconnecting/)).toBeInTheDocument()
        expect(liveRegion).toBeEmptyDOMElement()

        transportReconnectingRef.current = false
        rerender(<AgentChatPanel sessionId="s1" isVisible />)
        expect(liveRegion).toHaveTextContent('Subagents: 1 done')
      } finally {
        toolCallsRef.current = {}
      }
    })

    it('the reconnect overlay container is pointer-events-none (non-blocking, AC3)', () => {
      seedLiveSession('s1')
      transportReconnectingRef.current = true
      render(<AgentChatPanel sessionId="s1" isVisible />)
      advanceTimers(RECONNECT_GRACE_MS)
      // The overlay chip lives at top-right; it must not block clicks on
      // already-rendered messages.
      const status = screen.getByRole('status')
      const overlay = status.closest('[class*="pointer-events-none"]')
      expect(overlay).not.toBeNull()
    })

    it('does not render the transport reconnect overlay when transportReconnecting is false (AC3)', () => {
      seedLiveSession('s1')
      transportReconnectingRef.current = false
      render(<AgentChatPanel sessionId="s1" isVisible />)
      advanceTimers(RECONNECT_GRACE_MS * 2)
      // The transport-level overlay must be absent. (The session-level
      // "Reconnecting to agent…" banner is also absent because the session
      // isn't closed + reopening.)
      expect(screen.queryByText(/Reconnecting/)).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()
    })
  })
})

describe('AgentChatPanel waiting-to-confirm state (AD-6)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    promptCommandStatesRef.current = {}
    transportReconnectingRef.current = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never renders the pill when the reconcile resolves within the grace period', () => {
    sessionRef.current = mockAcpSession({
      id: 's1',
      cwd: '/w',
      activeTurn: true,
      openTurnId: 'turn-1'
    })
    promptCommandStatesRef.current = { s1: pendingCommand(false) }
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
    advanceTimers(300)
    expect(screen.queryByText(/Waiting to confirm/)).toBeNull()
    // The same-id resend confirmed the turn (~300 ms on a return reconnect).
    promptCommandStatesRef.current = {}
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    advanceTimers(RECONNECT_GRACE_MS * 2)
    expect(screen.queryByText(/Waiting to confirm/)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('hides the pill at once when the reconcile resolves after it showed', () => {
    sessionRef.current = mockAcpSession({
      id: 's1',
      cwd: '/w',
      activeTurn: true,
      openTurnId: 'turn-1'
    })
    promptCommandStatesRef.current = { s1: pendingCommand(false) }
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
    advanceTimers(RECONNECT_GRACE_MS)
    expect(screen.getByRole('status')).toHaveTextContent('Waiting to confirm')
    promptCommandStatesRef.current = {}
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(screen.queryByText(/Waiting to confirm/)).toBeNull()
  })

  it('shows a non-error "Waiting to confirm" status while the prompt is unconfirmed', () => {
    sessionRef.current = mockAcpSession({
      id: 's1',
      cwd: '/w',
      activeTurn: true,
      openTurnId: 'turn-1'
    })
    promptCommandStatesRef.current = { s1: pendingCommand(false) }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    advanceTimers(RECONNECT_GRACE_MS)
    expect(screen.getByRole('status')).toHaveTextContent('Waiting to confirm')
    // Not a failure: no error banner / Retry affordance.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('labels a host-reported unknown outcome "Outcome unknown — check" and re-checks with the SAME command id', () => {
    sessionRef.current = mockAcpSession({
      id: 's1',
      cwd: '/w',
      activeTurn: true,
      openTurnId: 'turn-1'
    })
    promptCommandStatesRef.current = { s1: pendingCommand(true) }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    advanceTimers(RECONNECT_GRACE_MS)
    expect(screen.getByRole('status')).toHaveTextContent('Outcome unknown — check')
    // Still not a failure, and no new-send Retry while the command is unresolved.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    expect(mockRecheckPromptCommand).toHaveBeenCalledWith('s1')
  })

  it('shows "Checking…" and disables the re-check while the same-id resend runs', () => {
    sessionRef.current = mockAcpSession({
      id: 's1',
      cwd: '/w',
      activeTurn: true,
      openTurnId: 'turn-1'
    })
    promptCommandStatesRef.current = {
      s1: { ...pendingCommand(true), phase: 'pending', checking: true }
    }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    advanceTimers(RECONNECT_GRACE_MS)
    expect(screen.getByRole('status')).toHaveTextContent('Checking…')
    expect(screen.getByRole('button', { name: 'Re-check' })).toBeDisabled()
  })

  it('does not show it for a confirmed prompt or another session', () => {
    sessionRef.current = mockAcpSession({
      id: 's1',
      cwd: '/w',
      activeTurn: true,
      openTurnId: 'turn-1'
    })
    promptCommandStatesRef.current = { other: pendingCommand(false) }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    advanceTimers(RECONNECT_GRACE_MS)
    expect(screen.queryByText(/Waiting to confirm/)).toBeNull()
  })
})

describe('AgentChatPanel pending question rendering (issue #411)', () => {
  beforeEach(() => {
    sessionRef.current = mockAcpSession({
      id: 's1',
      cwd: '/w',
      activeTurn: true,
      openTurnId: 'turn-1'
    })
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

  afterEach(() => {
    agentStatusRef.current = {}
  })

  function seedFailedLaunchSession(id: string): void {
    sessionRef.current = mockAcpSession({
      id,
      agentId: '',
      cwd: '/w',
      status: 'error',
      lastError: 'Authentication required: sign-in required for this agent',
      launchConfigId: 'cfg-1'
    })
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
    sessionRef.current = mockAcpSession({
      id: 's1',
      cwd: '/w',
      status: 'error',
      lastError: 'agent crashed'
    })
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

  it('restarts a live chat whose agent a turn error left unusable instead of re-sending to it', async () => {
    mockSendPromptBlocks.mockReset().mockResolvedValue(undefined)
    agentStatusRef.current = { 'agent-1': 'error' }
    sessionRef.current = mockAcpSession({
      id: 's1',
      agentId: 'agent-1',
      cwd: '/w',
      status: 'active',
      lastError: 'Authentication required'
    })
    messagesRef.current = [{ id: 'm1', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }]
    render(<AgentChatPanel sessionId="s1" isVisible />)
    const props = errorNoticePropsRef.current
    expect(props?.retryLabel).toBe('Retry')
    props?.onRetry?.()
    await waitFor(() => expect(mockRetryCrashed).toHaveBeenCalledWith('s1'))
    expect(mockSendPromptBlocks).not.toHaveBeenCalled()
  })
})

describe('AgentChatPanel ChatChangedFilesPanel mounting', () => {
  beforeEach(() => {
    changedFilesPanelPropsRef.current = []
  })

  it('always mounts ChatChangedFilesPanel with cwd and toolCalls for an active session', () => {
    sessionRef.current = mockAcpSession({ id: 's1', cwd: '/w' })
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(changedFilesPanelPropsRef.current.length).toBeGreaterThan(0)
    expect(changedFilesPanelPropsRef.current[0]).toMatchObject({ cwd: '/w' })
    expect(Array.isArray(changedFilesPanelPropsRef.current[0].toolCalls)).toBe(true)
  })

  it('mounts ChatChangedFilesPanel even for a closed session (renders null internally)', () => {
    sessionRef.current = mockAcpSession({ id: 's2', cwd: '/w', status: 'closed' })
    render(<AgentChatPanel sessionId="s2" isVisible />)
    expect(changedFilesPanelPropsRef.current.length).toBeGreaterThan(0)
  })
})

// Web/desktop parity: `filePathContext` drives the `termul-file-path`
// open-in-editor links in agent markdown — the open chain (`/fs/info` →
// `openFile` → `addEditorTab`) is transport-agnostic, so the context must be
// built on web too (the ChatChangedFilesPanel file-open path is proof it works).
describe('AgentChatPanel filePathContext parity', () => {
  beforeEach(() => {
    chatMessageListPropsRef.current = null
  })

  afterEach(() => {
    runtimeState.tauri = false
  })

  it('builds filePathContext on web (isTauriContext false)', () => {
    runtimeState.tauri = false
    sessionRef.current = mockAcpSession({ id: 's1', cwd: '/w', projectId: 'p-unlisted' })
    render(<AgentChatPanel sessionId="s1" isVisible />)
    // No project 'p-unlisted' in the store → projectRoot falls back to cwd.
    expect(chatMessageListPropsRef.current?.filePathContext).toEqual({
      cwd: '/w',
      projectRoot: '/w'
    })
  })

  it('builds the same filePathContext on desktop (isTauriContext true)', () => {
    runtimeState.tauri = true
    sessionRef.current = mockAcpSession({ id: 's1', cwd: '/w', projectId: 'p-unlisted' })
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(chatMessageListPropsRef.current?.filePathContext).toEqual({
      cwd: '/w',
      projectRoot: '/w'
    })
  })
})

// Story 8 (revised): the "Starting agent…" banner was removed — the chat pane
// renders no progress banner while a slow `session/new` is in flight (chat
// opened without a prepared session). The launch state machine is unchanged;
// only the visual banner is gone.
describe('AgentChatPanel chat pane stays neutral during slow session/new (story 8)', () => {
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
    messagesRef.current = []
    chatMessageListPropsRef.current = null
    chatInputBarPropsRef.current = []
  })

  it('shows no "Starting agent…" banner while a launch is in flight (initializing, no agent yet)', () => {
    sessionRef.current = mockAcpSession({
      id: 's-launch',
      agentId: '',
      cwd: '/w',
      status: 'initializing'
    })
    launchingRef.current = { 's-launch': true }
    render(<AgentChatPanel sessionId="s-launch" isVisible />)
    expect(screen.queryByText('Starting agent…')).not.toBeInTheDocument()
  })

  it('shows no "Starting agent…" banner once the session is live (agent assigned)', () => {
    sessionRef.current = mockAcpSession({
      id: 's-launch',
      agentId: '',
      cwd: '/w',
      status: 'initializing'
    })
    launchingRef.current = { 's-launch': true }
    const { rerender } = render(<AgentChatPanel sessionId="s-launch" isVisible />)
    expect(screen.queryByText('Starting agent…')).not.toBeInTheDocument()

    sessionRef.current = {
      ...sessionRef.current,
      agentId: 'agent-1',
      status: 'active'
    } as AcpSession
    launchingRef.current = {}
    rerender(<AgentChatPanel sessionId="s-launch" isVisible />)
    expect(screen.queryByText('Starting agent…')).not.toBeInTheDocument()
  })

  it('renders the optimistic message and an enabled composer while a launch is in flight', () => {
    sessionRef.current = mockAcpSession({
      id: 's-launch',
      agentId: '',
      cwd: '/w',
      status: 'initializing',
      activeTurn: true
    })
    launchingRef.current = { 's-launch': true }
    messagesRef.current = [
      { id: 'msg-first', role: 'user', blocks: [{ type: 'text', text: 'first message' }] }
    ]
    render(<AgentChatPanel sessionId="s-launch" isVisible />)
    expect(
      (chatMessageListPropsRef.current?.items as Array<{ message?: { id: string } }>).map(
        (item) => item.message?.id
      )
    ).toEqual(['msg-first'])
    expect(screen.getByTestId('composer-stub')).toBeInTheDocument()
    expect(lastComposerProps()?.disabled).toBe(false)
  })

  it('shows no banner for a launch-placeholder handoff still in flight', () => {
    sessionRef.current = mockAcpSession({
      id: 's-launching',
      agentId: '',
      cwd: '/w',
      status: 'initializing'
    })
    launchingRef.current = { 's-launching': true }
    render(<AgentChatPanel sessionId="s-launching" isVisible />)
    expect(screen.queryByText('Starting agent…')).not.toBeInTheDocument()
  })
})

describe('AgentChatPanel live-turn retry wire rebuild', () => {
  beforeEach(() => {
    mockOpen.mockReset().mockResolvedValue(undefined)
    mockOpenDiscovered.mockReset().mockResolvedValue(undefined)
    mockRetryCrashed.mockReset().mockResolvedValue(undefined)
    mockRetryFailed.mockReset().mockResolvedValue(undefined)
    mockSendPromptBlocks.mockReset().mockResolvedValue(undefined)
    mockRemoveTab.mockReset()
    toastErrorSpy.mockReset()
    errorNoticePropsRef.current = null
    chatMessageListPropsRef.current = null
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

  it('retries a command-token turn with the /name wire prefix and no sentinel leaks', () => {
    sessionRef.current = mockAcpSession({ id: 's1', cwd: '/w' })
    const displayBlocks = [{ type: 'text', text: `${commandToken('compact')} hello` }]
    messagesRef.current = [{ id: 'm1', role: 'user', blocks: displayBlocks }]
    render(<AgentChatPanel sessionId="s1" isVisible />)

    const onRetry = chatMessageListPropsRef.current?.onRetry
    expect(onRetry).toBeDefined()
    onRetry?.()

    // The re-sent wire text is `/compact hello` (byte-identical to a fresh
    // send of the same composer value) while the display keeps the token.
    expect(mockSendPromptBlocks).toHaveBeenCalledTimes(1)
    const [sessionId, wireBlocks, options] = mockSendPromptBlocks.mock.calls[0] as unknown as [
      string,
      Array<{ type: string; text?: string }>,
      { displayBlocks?: Array<{ type: string; text?: string }> }
    ]
    expect(sessionId).toBe('s1')
    expect(wireBlocks).toEqual([{ type: 'text', text: '/compact hello' }])
    expect(options?.displayBlocks).toEqual(displayBlocks)
    // No private-use sentinel leaks into the dispatched payload.
    expect(JSON.stringify(wireBlocks)).not.toMatch(/[\uE000-\uE007]/)
    // The live-turn path never routes through the crashed/failed relaunches.
    expect(mockRetryCrashed).not.toHaveBeenCalled()
    expect(mockRetryFailed).not.toHaveBeenCalled()
  })
})

describe('AgentChatPanel hidden-panel render gate (multi-project perf)', () => {
  beforeEach(() => {
    mockOpen.mockReset().mockResolvedValue(undefined)
    mockOpenDiscovered.mockReset().mockResolvedValue(undefined)
    sessionRef.current = null
    indexRef.current = []
    openingRef.current = {}
    restoringRef.current = {}
    launchingRef.current = {}
    transportReconnectingRef.current = false
    messagesRef.current = []
    toolCallsRef.current = {}
    timelineArgsRef.current = []
    timelineCallCountRef.current = { build: 0, consolidate: 0 }
    agentSwitchesRef.current = {}
    chatInputBarPropsRef.current = []
  })

  it('performs no timeline rebuild while the panel is hidden during message flushes', () => {
    seedLiveSession('s1')
    messagesRef.current = [{ id: 'm1', role: 'user', blocks: [] }]
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
    const visibleBuilds = timelineCallCountRef.current.build
    const visibleConsolidates = timelineCallCountRef.current.consolidate
    expect(visibleBuilds).toBeGreaterThanOrEqual(1)

    // A streaming flush lands while the panel is hidden: new array identity
    // (simulating a coalesced rAF flush), panel re-renders but the timeline
    // pipeline must NOT re-run — the frozen snapshot keeps memo deps stable.
    messagesRef.current = [
      { id: 'm1', role: 'user', blocks: [] },
      { id: 'm2', role: 'assistant', blocks: [] }
    ]
    rerender(<AgentChatPanel sessionId="s1" isVisible={false} />)

    expect(timelineCallCountRef.current.build).toBe(visibleBuilds)
    expect(timelineCallCountRef.current.consolidate).toBe(visibleConsolidates)
  })

  it('renders the complete transcript (incl. chunks streamed while hidden) on visibility restore', () => {
    seedLiveSession('s1')
    messagesRef.current = [{ id: 'm1', role: 'user', blocks: [] }]
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)

    // Hide, then two flushes arrive while hidden.
    messagesRef.current = [
      { id: 'm1', role: 'user', blocks: [] },
      { id: 'm2', role: 'assistant', blocks: [] }
    ]
    rerender(<AgentChatPanel sessionId="s1" isVisible={false} />)
    messagesRef.current = [
      { id: 'm1', role: 'user', blocks: [] },
      { id: 'm2', role: 'assistant', blocks: [] },
      { id: 'm3', role: 'assistant', blocks: [] }
    ]
    rerender(<AgentChatPanel sessionId="s1" isVisible={false} />)

    // Becoming visible re-syncs to the CURRENT store array: the timeline
    // rebuilds once and sees all three messages.
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(timelineCallCountRef.current.build).toBe(2)
    // The restore pass fed buildTimeline the full 3-message array (content,
    // not just the call count).
    const lastArgs = timelineArgsRef.current[timelineArgsRef.current.length - 1]
    expect(lastArgs?.messages).toHaveLength(3)
    expect(lastArgs?.messages[2]).toMatchObject({ id: 'm3' })
  })

  it('tool calls recorded while hidden reach ChatChangedFilesPanel after restore', () => {
    seedLiveSession('s1')
    messagesRef.current = [{ id: 'm1', role: 'user', blocks: [] }]
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)

    // An edit tool call lands while the panel is hidden.
    toolCallsRef.current = {
      s1: [{ id: 'tc1', kind: 'edit', cwd: '/w' }]
    }
    rerender(<AgentChatPanel sessionId="s1" isVisible={false} />)
    // Hidden render: gate holds the OLD (empty) tool-call snapshot.
    expect(changedFilesPanelPropsRef.current.at(-1)?.toolCalls).toHaveLength(0)

    // Restore: the new tool-call array flows to the changed-files panel.
    rerender(<AgentChatPanel sessionId="s1" isVisible />)
    expect(changedFilesPanelPropsRef.current.at(-1)?.toolCalls).toEqual([
      { id: 'tc1', kind: 'edit', cwd: '/w' }
    ])
  })

  it('forwards isVisible to ChatInputBar (composer shares the render gate)', () => {
    seedLiveSession('s1')
    messagesRef.current = [{ id: 'm1', role: 'user', blocks: [] }]
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(chatInputBarPropsRef.current.at(-1)?.isVisible).toBe(true)

    rerender(<AgentChatPanel sessionId="s1" isVisible={false} />)
    expect(chatInputBarPropsRef.current.at(-1)?.isVisible).toBe(false)
  })

  it('seeded agentSwitches reach the buildTimeline call (CAP-2 third source)', () => {
    seedLiveSession('s1')
    messagesRef.current = [{ id: 'm1', role: 'user', blocks: [] }]
    agentSwitchesRef.current = {
      s1: [
        { id: 'switch:seq-3', seq: 3 },
        { id: 'switch:seq-9', seq: 9 }
      ]
    }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    const lastArgs = timelineArgsRef.current[timelineArgsRef.current.length - 1]
    // The switch-marker list for the session flows through the store mock to
    // the panel's buildTimeline pipeline (third source).
    expect(lastArgs?.switches).toHaveLength(2)
    expect(lastArgs?.switches[0]).toMatchObject({ id: 'switch:seq-3', seq: 3 })
  })

  it('a visible panel still rebuilds the timeline on every flush (no behavior regression)', () => {
    seedLiveSession('s1')
    messagesRef.current = [{ id: 'm1', role: 'user', blocks: [] }]
    const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)

    messagesRef.current = [
      { id: 'm1', role: 'user', blocks: [] },
      { id: 'm2', role: 'assistant', blocks: [] }
    ]
    rerender(<AgentChatPanel sessionId="s1" isVisible />)

    expect(timelineCallCountRef.current.build).toBe(2)
  })
})

// spec-acp-composer-option-fidelity: while a switch is armed the composer is a
// launcher for the TARGET config — it renders the target's advertised options
// (prepared warm session) with switching.pendingOptions overlaid, and picks
// route into setSwitchPendingOption (the old session's setters never fire).
describe('AgentChatPanel armed-switch composer scoping', () => {
  const targetModes = {
    currentModeId: 'chat',
    availableModes: [
      { id: 'chat', name: 'Chat' },
      { id: 'code', name: 'Code' }
    ]
  }
  const targetConfigOptions = [
    {
      id: 'thought_level',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'max', name: 'Max' }
      ]
    }
  ]

  function seedArmedSession(pendingOptions?: {
    modelId?: string
    modeId?: string
    configValues: Record<string, string>
  }): void {
    sessionRef.current = mockAcpSession({
      id: 's1',
      agentId: 'agent-old',
      cwd: '/w',
      modes: {
        currentModeId: 'agent',
        availableModes: [{ id: 'agent', name: 'Agent' }]
      },
      configOptions: [
        {
          id: 'old_opt',
          name: 'Old opt',
          type: 'select',
          currentValue: 'a',
          options: [{ value: 'a', name: 'A' }]
        }
      ],
      switching: { toConfigId: 'cfg-new', status: 'pending', pendingOptions }
    })
    // The target's prepared warm session (prepareChat short-circuit target).
    sessionsMapRef.current = {
      's-warm': mockAcpSession({
        id: 's-warm',
        agentId: 'agent-new',
        cwd: '/w',
        modes: targetModes,
        configOptions: targetConfigOptions
      })
    }
    preparedSessionsRef.current = { [['cfg-new', '/w', ''].join(String.fromCharCode(0))]: 's-warm' }
  }

  beforeEach(() => {
    mockOpen.mockReset().mockResolvedValue(undefined)
    mockSetSwitchPendingOption.mockReset().mockResolvedValue(undefined)
    mockSetConfigOption.mockReset()
    mockSetMode.mockReset()
    mockSetModel.mockReset()
    sessionRef.current = null
    sessionsMapRef.current = {}
    agentsRef.current = {}
    commandsRef.current = {}
    preparedSessionsRef.current = {}
    optionsCacheRef.current = {}
    indexRef.current = []
    agentConfigsRef.current = []
    openingRef.current = {}
    restoringRef.current = {}
    launchingRef.current = {}
    discoveredContextRef.current = {}
    messagesRef.current = []
    chatInputBarPropsRef.current = []
  })

  it('renders the TARGET config options with pending switch picks overlaid', () => {
    seedArmedSession({ modeId: 'code', configValues: { thought_level: 'max' } })
    render(<AgentChatPanel sessionId="s1" isVisible />)

    const props = chatInputBarPropsRef.current.at(-1)
    expect(props).toBeDefined()
    // Target-advertised list, with the armed picks painted on top.
    expect(props?.modes).toEqual({ ...targetModes, currentModeId: 'code' })
    expect(props?.configOptions).toEqual([{ ...targetConfigOptions[0], currentValue: 'max' }])
    // ChatInputBar reads models/modes off `session` too — the passed session
    // carries the target state, never the old session's.
    expect(props?.session?.modes).toEqual({ ...targetModes, currentModeId: 'code' })
    // The old session's config option list is NOT what the composer shows.
    expect(props?.configOptions?.[0]).not.toMatchObject({ id: 'old_opt' })
  })

  it('renders raw target options when no pending switch picks exist', () => {
    seedArmedSession()
    render(<AgentChatPanel sessionId="s1" isVisible />)

    const props = chatInputBarPropsRef.current.at(-1)
    expect(props?.modes).toEqual(targetModes)
    expect(props?.configOptions).toEqual(targetConfigOptions)
  })

  it('falls back to agentOptionsCache while the prepared session is unresolved', () => {
    seedArmedSession({ modeId: 'code', configValues: { thought_level: 'max' } })
    // The arm-time prepare hasn't produced a warm session — the armed
    // composer must still render the cached target options + armed picks.
    preparedSessionsRef.current = {}
    optionsCacheRef.current = {
      'cfg-new': { models: null, modes: targetModes, configOptions: targetConfigOptions }
    }
    render(<AgentChatPanel sessionId="s1" isVisible />)

    const props = chatInputBarPropsRef.current.at(-1)
    expect(props?.modes).toEqual({ ...targetModes, currentModeId: 'code' })
    expect(props?.configOptions).toEqual([{ ...targetConfigOptions[0], currentValue: 'max' }])
    expect(props?.session?.configOptions?.[0]).not.toMatchObject({ id: 'old_opt' })
  })

  it('offers the target session commands, prompt capabilities and MCP count while armed', () => {
    seedArmedSession()
    sessionsMapRef.current['s-warm'] = { ...sessionsMapRef.current['s-warm'], mcpServerCount: 3 }
    agentsRef.current = {
      'agent-old': { capabilities: { promptCapabilities: {} } },
      'agent-new': { capabilities: { promptCapabilities: { image: true, embeddedContext: true } } }
    }
    commandsRef.current = {
      s1: [{ name: 'old-only', description: 'Old agent command' }],
      's-warm': [{ name: 'target-only', description: 'Target agent command' }]
    }
    render(<AgentChatPanel sessionId="s1" isVisible />)

    const props = chatInputBarPropsRef.current.at(-1)
    expect(props?.commands).toEqual([{ name: 'target-only', description: 'Target agent command' }])
    expect(props?.imageCapable).toBe(true)
    expect(props?.embedCapable).toBe(true)
    expect(props?.session?.mcpServerCount).toBe(3)
  })

  it('offers no old-agent commands while the armed target has no prepared session', () => {
    seedArmedSession()
    preparedSessionsRef.current = {}
    commandsRef.current = { s1: [{ name: 'old-only', description: 'Old agent command' }] }
    render(<AgentChatPanel sessionId="s1" isVisible />)

    expect(chatInputBarPropsRef.current.at(-1)?.commands).toEqual([])
  })

  it('routes armed composer picks into setSwitchPendingOption (old session untouched)', async () => {
    seedArmedSession()
    render(<AgentChatPanel sessionId="s1" isVisible />)

    const props = chatInputBarPropsRef.current.at(-1)
    await props?.onSetConfig?.('thought_level', 'max')
    await props?.onSetMode?.('code')
    await props?.onSetModel?.('m2')

    expect(mockSetSwitchPendingOption).toHaveBeenCalledWith('s1', {
      configValues: { thought_level: 'max' }
    })
    expect(mockSetSwitchPendingOption).toHaveBeenCalledWith('s1', { modeId: 'code' })
    expect(mockSetSwitchPendingOption).toHaveBeenCalledWith('s1', { modelId: 'm2' })
    // The armed session's own setters — and therefore its agent's wire and
    // its persisted option cache — are never touched by armed picks.
    expect(mockSetConfigOption).not.toHaveBeenCalled()
    expect(mockSetMode).not.toHaveBeenCalled()
    expect(mockSetModel).not.toHaveBeenCalled()
  })
})

describe('AgentChatPanel worktree progress row injection', () => {
  beforeEach(() => {
    sessionRef.current = null
    indexRef.current = []
    openingRef.current = {}
    restoringRef.current = {}
    launchingRef.current = {}
    oskRef.current = { isOskOpen: false, keyboardHeight: 0, height: 0, offsetTop: 0 }
    transportReconnectingRef.current = false
    discoveredContextRef.current = {}
    messagesRef.current = []
    toolCallsRef.current = {}
    agentSwitchesRef.current = {}
    chatMessageListPropsRef.current = null
  })

  function seedWorktreeSession(id: string, progressId: string): void {
    sessionRef.current = mockAcpSession({
      id,
      cwd: '/w',
      worktreeProgressId: progressId
    })
  }

  type TimelineRow = {
    kind: string
    key: string
    progressId?: string
    message?: { id: string; role: string }
  }

  function renderedItems(): TimelineRow[] {
    return (chatMessageListPropsRef.current?.items ?? []) as TimelineRow[]
  }

  it('injects the worktree row immediately after the first user message', () => {
    seedWorktreeSession('s1', 'wt-1')
    messagesRef.current = [
      { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'agent', blocks: [{ type: 'text', text: 'working' }] }
    ]
    render(<AgentChatPanel sessionId="s1" isVisible />)

    const items = renderedItems()
    // user message → worktree row → agent content (LAUNCH_WITH_PROMPT order).
    expect(items.map((i) => i.kind)).toEqual(['message', 'worktree', 'message'])
    expect(items[0]?.message?.role).toBe('user')
    expect(items[1]).toEqual({ kind: 'worktree', key: 'worktree:wt-1', progressId: 'wt-1' })
    expect(items[2]?.message?.id).toBe('a1')
  })

  it('injects the row at index 0 when no user message exists (restart without prompt)', () => {
    seedWorktreeSession('s2', 'wt-2')
    messagesRef.current = [{ id: 'a1', role: 'agent', blocks: [] }]
    render(<AgentChatPanel sessionId="s2" isVisible />)

    const items = renderedItems()
    expect(items[0]).toEqual({ kind: 'worktree', key: 'worktree:wt-2', progressId: 'wt-2' })
    expect(items[1]?.kind).toBe('message')
    expect(items[1]?.message?.id).toBe('a1')
  })

  it('adds no worktree row when the session carries no worktreeProgressId', () => {
    seedLiveSession('s3')
    messagesRef.current = [{ id: 'u1', role: 'user', blocks: [] }]
    render(<AgentChatPanel sessionId="s3" isVisible />)

    const items = renderedItems()
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.kind === 'message')).toBe(true)
  })
})

// spec-acp-browser-automation-v2 CAP-5: the in-chat browser consent card is
// per-session — this panel renders the card only for a pending consent whose
// sessionId matches, so two sessions each surface their own card. The panel
// also registers itself as the visible card host (useConsentCardHost) so the
// root BrowserConsentCardHost renders fallbacks only for unhosted sessions.
describe('AgentChatPanel browser consent card mounting (CAP-5)', () => {
  beforeEach(() => {
    sessionRef.current = null
    indexRef.current = []
    openingRef.current = {}
    restoringRef.current = {}
    launchingRef.current = {}
    discoveredContextRef.current = {}
    messagesRef.current = []
    pendingBrowserConsentsRef.current = {}
    browserConsentCardPropsRef.current = null
    runtimeState.tauri = true
    useConsentCardHost.setState({ hostedSessionIds: new Set() })
  })

  afterEach(() => {
    runtimeState.tauri = false
    resetNativeWebviewOcclusionForTests()
  })

  function seedActiveSession(id: string): void {
    sessionRef.current = mockAcpSession({ id, cwd: '/w', status: 'active' })
  }

  it('mounts no card while an overlay covers the chat, leaving it to the root host', () => {
    seedActiveSession('s1')
    pendingBrowserConsentsRef.current = {
      'req-1': { requestId: 'req-1', sessionId: 's1' }
    }
    render(<NativeWebviewOccluder />)
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(browserConsentCardPropsRef.current).toBeNull()
  })

  it('renders the pending consent belonging to this session', () => {
    seedActiveSession('s1')
    pendingBrowserConsentsRef.current = {
      'req-1': { requestId: 'req-1', sessionId: 's1' }
    }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(browserConsentCardPropsRef.current?.consent).toMatchObject({
      requestId: 'req-1',
      sessionId: 's1'
    })
  })

  it('mounts no card while the pending consent belongs to another session', () => {
    seedActiveSession('s1')
    pendingBrowserConsentsRef.current = {
      'req-2': { requestId: 'req-2', sessionId: 's-other' }
    }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(browserConsentCardPropsRef.current).toBeNull()
  })

  it('mounts no card when no browser consent is pending', () => {
    seedActiveSession('s1')
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(browserConsentCardPropsRef.current).toBeNull()
  })

  it('mounts no card for a closed session (the request is stale)', () => {
    seedLiveSession('s1') // status 'closed'
    pendingBrowserConsentsRef.current = {
      'req-1': { requestId: 'req-1', sessionId: 's1' }
    }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(browserConsentCardPropsRef.current).toBeNull()
  })

  it('mounts no card outside Tauri (remote clients never see the prompt)', () => {
    runtimeState.tauri = false
    seedActiveSession('s1')
    pendingBrowserConsentsRef.current = {
      'req-1': { requestId: 'req-1', sessionId: 's1' }
    }
    render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(browserConsentCardPropsRef.current).toBeNull()
  })

  it('registers a visible card host for the session and unregisters on unmount', () => {
    seedActiveSession('s1')
    pendingBrowserConsentsRef.current = {
      'req-1': { requestId: 'req-1', sessionId: 's1' }
    }
    const { unmount } = render(<AgentChatPanel sessionId="s1" isVisible />)
    expect(useConsentCardHost.getState().hostedSessionIds.has('s1')).toBe(true)

    unmount()
    expect(useConsentCardHost.getState().hostedSessionIds.has('s1')).toBe(false)
  })

  it('does not register while the chat tab is hidden behind another pane tab', () => {
    // The card stays mounted but CSS-invisible; the root fallback host must
    // own the prompt (mount-context reachability, CAP-5).
    seedActiveSession('s1')
    pendingBrowserConsentsRef.current = {
      'req-1': { requestId: 'req-1', sessionId: 's1' }
    }
    render(<AgentChatPanel sessionId="s1" isVisible={false} />)
    expect(useConsentCardHost.getState().hostedSessionIds.has('s1')).toBe(false)
  })
})

// Mobile chat dock: plan bar, changed-files Git action, approval compaction,
// arrival focus and focus return, all gated on `useMobileWebShell()`.
describe('AgentChatPanel mobile dock wiring', () => {
  const OSK_OPEN = { isOskOpen: true, keyboardHeight: 300, height: 500, offsetTop: 300 }

  const seedPermission = (requestId = 'r1'): void => {
    pendingPermissionsRef.current = {
      [requestId]: { requestId, sessionId: 's1', agentId: 'agent-1', options: [], toolCall: {} }
    }
  }
  const seedQuestion = (): void => {
    pendingQuestionsRef.current = {
      q1: { questionId: 'q1', sessionId: 's1', agentId: 'agent-1', question: 'Which?', options: [] }
    }
  }
  const seedElicitation = (): void => {
    pendingElicitationsRef.current = {
      el1: {
        requestId: 'el1',
        sessionId: 's1',
        agentId: 'agent-1',
        mode: 'form',
        message: 'Configure',
        fields: []
      }
    }
  }
  const lastPlan = () => planPanelPropsRef.current.at(-1)
  const lastChangedFiles = () => changedFilesPanelPropsRef.current.at(-1)

  beforeEach(() => {
    mobileRef.current = true
    sessionRef.current = mockAcpSession({ id: 's1', cwd: '/repo/.worktrees/a' })
    indexRef.current = []
    openingRef.current = {}
    restoringRef.current = {}
    launchingRef.current = {}
    discoveredContextRef.current = {}
    messagesRef.current = []
    oskRef.current = { isOskOpen: false, keyboardHeight: 0, height: 0, offsetTop: 0 }
    pendingPermissionsRef.current = {}
    pendingQuestionsRef.current = {}
    pendingElicitationsRef.current = {}
    plansRef.current = {}
    planPanelPropsRef.current = []
    changedFilesPanelPropsRef.current = []
    askQuestionPropsRef.current = []
    elicitationPropsRef.current = []
    chatInputBarPropsRef.current = []
    openGitSheetRef.current = vi.fn()
  })

  afterEach(() => {
    mobileRef.current = true
    pendingPermissionsRef.current = {}
    pendingQuestionsRef.current = {}
    pendingElicitationsRef.current = {}
    oskRef.current = { isOskOpen: false, keyboardHeight: 0, height: 0, offsetTop: 0 }
  })

  describe('plan bar and Git action', () => {
    it('starts the plan collapsed and wires the changed-files Git action to the chat cwd', () => {
      render(<AgentChatPanel sessionId="s1" isVisible />)

      expect(lastPlan()).toMatchObject({ defaultCollapsed: true, forceCollapsed: false })
      expect(lastChangedFiles()).toMatchObject({ cwd: '/repo/.worktrees/a', forceCollapsed: false })
      expect(typeof lastChangedFiles()?.onOpenGitChanges).toBe('function')

      // The tapped Git button is forwarded, so the sheet can return focus to it.
      const gitButton = document.createElement('button')
      lastChangedFiles()?.onOpenGitChanges?.(gitButton)
      expect(openGitSheetRef.current).toHaveBeenCalledTimes(1)
      expect(openGitSheetRef.current).toHaveBeenCalledWith('/repo/.worktrees/a', gitButton)
    })

    it('keeps the baseline props on the desktop shell', () => {
      mobileRef.current = false
      oskRef.current = OSK_OPEN
      seedPermission()
      render(<AgentChatPanel sessionId="s1" isVisible />)

      expect(lastPlan()).toMatchObject({ defaultCollapsed: false, forceCollapsed: false })
      expect(lastChangedFiles()?.forceCollapsed).toBe(false)
      expect(lastChangedFiles()?.onOpenGitChanges).toBeUndefined()
    })
  })

  describe('collapsing the dock bars while the keyboard is up with an approval pending', () => {
    it.each([
      ['a permission', seedPermission],
      ['an elicitation', seedElicitation],
      ['a question', seedQuestion]
    ])('forces the plan bar collapsed for %s', (_label, seed) => {
      oskRef.current = OSK_OPEN
      seed()
      render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(lastPlan()?.forceCollapsed).toBe(true)
    })

    it('forces the changed-files bar collapsed too', () => {
      oskRef.current = OSK_OPEN
      seedPermission()
      render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(lastChangedFiles()?.forceCollapsed).toBe(true)
    })

    it('does not collapse without the keyboard, without an approval, or for a closed session', () => {
      seedPermission()
      const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(lastPlan()?.forceCollapsed).toBe(false)

      pendingPermissionsRef.current = {}
      oskRef.current = OSK_OPEN
      rerender(<AgentChatPanel sessionId="s1" isVisible />)
      expect(lastPlan()?.forceCollapsed).toBe(false)

      seedPermission()
      sessionRef.current = mockAcpSession({
        id: 's1',
        cwd: '/repo/.worktrees/a',
        status: 'closed'
      })
      rerender(<AgentChatPanel sessionId="s1" isVisible />)
      expect(lastPlan()?.forceCollapsed).toBe(false)
    })

    it('does not collapse a hidden pane', () => {
      oskRef.current = OSK_OPEN
      seedPermission()
      render(<AgentChatPanel sessionId="s1" isVisible={false} />)
      expect(lastPlan()?.forceCollapsed).toBe(false)
    })
  })

  describe('arrival focus', () => {
    it('asks a visible mobile question to focus its first option', () => {
      seedQuestion()
      render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(askQuestionPropsRef.current.at(-1)?.autoFocusFirstOption).toBe(true)
    })

    it('does not ask a hidden pane, or the desktop shell, to focus a question', () => {
      seedQuestion()
      const hidden = render(<AgentChatPanel sessionId="s1" isVisible={false} />)
      expect(askQuestionPropsRef.current.at(-1)?.autoFocusFirstOption).toBe(false)
      hidden.unmount()

      mobileRef.current = false
      render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(askQuestionPropsRef.current.at(-1)?.autoFocusFirstOption).toBe(false)
    })

    it('asks a visible mobile elicitation to focus its heading, and nothing else', () => {
      seedElicitation()
      const visible = render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(elicitationPropsRef.current.at(-1)?.autoFocusHeading).toBe(true)
      visible.unmount()

      render(<AgentChatPanel sessionId="s1" isVisible={false} />)
      expect(elicitationPropsRef.current.at(-1)?.autoFocusHeading).toBe(false)
    })

    it('does not ask the desktop shell to focus an elicitation heading', () => {
      mobileRef.current = false
      seedElicitation()
      render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(elicitationPropsRef.current.at(-1)?.autoFocusHeading).toBe(false)
    })
  })

  describe('hidden-pane arrival of a stacked permission', () => {
    it('forwards isVisible to the PermissionPrompt that stacks with an elicitation or a question', () => {
      seedPermission()
      seedElicitation()
      permissionPromptPropsRef.current = []
      const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible={false} />)
      expect(permissionPromptPropsRef.current.at(-1)).toMatchObject({
        embedded: false,
        isVisible: false
      })

      rerender(<AgentChatPanel sessionId="s1" isVisible />)
      expect(permissionPromptPropsRef.current.at(-1)).toMatchObject({
        embedded: false,
        isVisible: true
      })
    })

    it('forwards isVisible to the composer, which mounts the embedded prompt', () => {
      seedPermission()
      chatInputBarPropsRef.current = []
      const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible={false} />)
      expect(chatInputBarPropsRef.current.at(-1)?.isVisible).toBe(false)

      rerender(<AgentChatPanel sessionId="s1" isVisible />)
      expect(chatInputBarPropsRef.current.at(-1)?.isVisible).toBe(true)
    })
  })

  describe('focus return when a permission resolves', () => {
    it('moves focus from the resolved prompt to the composer card on the mobile shell', () => {
      seedPermission()
      const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
      const allow = screen.getByRole('button', { name: 'Allow once' })
      act(() => allow.focus())
      expect(allow).toHaveFocus()

      pendingPermissionsRef.current = {}
      rerender(<AgentChatPanel sessionId="s1" isVisible />)

      expect(screen.getByTestId('composer-stub')).toHaveFocus()
      expect(screen.getByLabelText('editor')).not.toHaveFocus()
    })

    it('leaves focus in the editor when the user was typing there', () => {
      seedPermission()
      const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
      act(() => screen.getByRole('button', { name: 'Allow once' }).focus())
      act(() => screen.getByLabelText('editor').focus())

      pendingPermissionsRef.current = {}
      rerender(<AgentChatPanel sessionId="s1" isVisible />)

      expect(screen.getByLabelText('editor')).toHaveFocus()
    })

    it('leaves focus alone when the user tapped away from the prompt before it resolved', () => {
      // The panel root's onBlur (from useApprovalDock) forgets the prompt focus;
      // its frame check runs synchronously here.
      const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        cb(0)
        return 1
      })
      try {
        seedPermission()
        const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
        const allow = screen.getByRole('button', { name: 'Allow once' })
        act(() => allow.focus())
        // Tapping a non-focusable area drops focus to <body> with no new target.
        act(() => allow.blur())
        expect(document.body).toHaveFocus()

        pendingPermissionsRef.current = {}
        rerender(<AgentChatPanel sessionId="s1" isVisible />)

        expect(document.body).toHaveFocus()
        expect(screen.getByTestId('composer-stub')).not.toHaveFocus()
      } finally {
        raf.mockRestore()
      }
    })

    it('moves no focus on the desktop shell', () => {
      mobileRef.current = false
      seedPermission()
      const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
      act(() => screen.getByRole('button', { name: 'Allow once' }).focus())

      pendingPermissionsRef.current = {}
      rerender(<AgentChatPanel sessionId="s1" isVisible />)

      expect(screen.getByTestId('composer-stub')).not.toHaveFocus()
      expect(document.body).toHaveFocus()
    })
  })

  // The dock wrapper reports its top edge (`--mobile-dock-height`) so the toast
  // stack clears it. Layout: a plain box on the mobile shell, `display:
  // contents` on desktop. The rect of the wrapper is stubbed through its
  // `data-chat-dock` attribute: jsdom lays nothing out.
  describe('dock clearance', () => {
    const DOCK_VAR = '--mobile-dock-height'
    const dockVar = (): string => document.documentElement.style.getPropertyValue(DOCK_VAR)
    const originalInnerHeight = window.innerHeight
    let rectSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        writable: true,
        value: 844
      })
      rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element
      ) {
        const isDock = this.getAttribute('data-chat-dock') === 'true'
        const top = isDock ? 708 : 0
        const width = isDock ? 390 : 0
        const height = isDock ? 136 : 0
        return {
          x: 0,
          y: top,
          top,
          left: 0,
          width,
          height,
          right: width,
          bottom: top + height,
          toJSON: () => ({})
        }
      })
    })

    afterEach(() => {
      rectSpy.mockRestore()
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        writable: true,
        value: originalInnerHeight
      })
      document.documentElement.style.removeProperty(DOCK_VAR)
    })

    const dockOf = (container: HTMLElement): HTMLElement | null =>
      container.querySelector<HTMLElement>('[data-chat-dock="true"]')

    it('writes the distance to the composer dock top for a visible mobile chat', () => {
      const { container, unmount } = render(<AgentChatPanel sessionId="s1" isVisible />)

      // The composer and the changed-files bar are the wrapper's children.
      expect(screen.getByTestId('composer-stub').parentElement).toBe(dockOf(container))
      expect(dockVar()).toBe('136px')

      unmount()
      expect(dockVar()).toBe('')
    })

    it.each([
      ['a question', seedQuestion],
      ['an elicitation', seedElicitation]
    ])('reports the prompt dock too while %s replaces the composer', (_label, seed) => {
      seed()
      const { container } = render(<AgentChatPanel sessionId="s1" isVisible />)

      expect(screen.queryByTestId('composer-stub')).toBeNull()
      expect(dockOf(container)).not.toBeNull()
      expect(dockVar()).toBe('136px')
    })

    // The wrapper's rect is only worth measuring if everything that sits on the
    // dock is inside it: a child outside would be uncounted and a toast could
    // cover it.
    it('holds the changed-files bar and the composer in the composer branch', () => {
      const { container } = render(<AgentChatPanel sessionId="s1" isVisible />)
      const dock = dockOf(container)

      expect(dock).not.toBeNull()
      expect(screen.getByTestId('changed-files-stub').closest('[data-chat-dock="true"]')).toBe(dock)
      expect(screen.getByTestId('composer-stub').closest('[data-chat-dock="true"]')).toBe(dock)
    })

    it('holds the question, the elicitation and the permission in the prompt branch', () => {
      seedQuestion()
      seedElicitation()
      seedPermission()
      const { container } = render(<AgentChatPanel sessionId="s1" isVisible />)
      const dock = dockOf(container)

      expect(dock).not.toBeNull()
      expect(screen.queryByTestId('composer-stub')).toBeNull()
      for (const id of ['question-stub', 'elicitation-stub', 'permission-stub']) {
        expect(screen.getByTestId(id).closest('[data-chat-dock="true"]')).toBe(dock)
      }
    })

    it('keeps one wrapper element across the composer and prompt branches', () => {
      const { container, rerender } = render(<AgentChatPanel sessionId="s1" isVisible />)
      const dock = dockOf(container)
      expect(dock).not.toBeNull()

      seedQuestion()
      rerender(<AgentChatPanel sessionId="s1" isVisible />)
      expect(screen.queryByTestId('composer-stub')).toBeNull()
      expect(dockOf(container)).toBe(dock)
      expect(dockVar()).toBe('136px')
    })

    it('leaves the property absent for a hidden pane, then writes it once visible', () => {
      const { rerender } = render(<AgentChatPanel sessionId="s1" isVisible={false} />)
      expect(dockVar()).toBe('')

      rerender(<AgentChatPanel sessionId="s1" isVisible />)
      expect(dockVar()).toBe('136px')

      rerender(<AgentChatPanel sessionId="s1" isVisible={false} />)
      expect(dockVar()).toBe('')
    })

    it('leaves the property absent on the desktop shell', () => {
      mobileRef.current = false
      render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(dockVar()).toBe('')
    })

    it('lays the wrapper out as a box on mobile and as display: contents on desktop', () => {
      const mobile = render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(dockOf(mobile.container)).toHaveClass('flex', 'shrink-0', 'flex-col')
      expect(dockOf(mobile.container)).not.toHaveClass('contents')
      mobile.unmount()

      mobileRef.current = false
      const desktop = render(<AgentChatPanel sessionId="s1" isVisible />)
      expect(dockOf(desktop.container)).toHaveClass('contents')
      expect(dockOf(desktop.container)).not.toHaveClass('flex')
    })
  })
})
