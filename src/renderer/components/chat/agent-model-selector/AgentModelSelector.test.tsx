import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { AgentModelSelector } from './AgentModelSelector'

// jsdom omits `document.elementFromPoint`; Radix/floating-ui call it while
// positioning the popover. Same stub as ChatInputBar.test.tsx.
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
    writable: true
  })
}

const {
  mockArmAgentSwitch,
  mockSetSwitchPendingOption,
  mockCancelAgentSwitch,
  mockCancelPrompt,
  mockPrepareChat,
  mockSaveAgentConfig,
  mockInstallAcpAgent,
  mockToastSuccess,
  mockToastError,
  mockResolvedAgents,
  mockIsMobile,
  subscribeListeners,
  acpStateRef
} = vi.hoisted(() => ({
  mockArmAgentSwitch: vi.fn(async () => true),
  mockSetSwitchPendingOption: vi.fn(async () => {}),
  mockCancelAgentSwitch: vi.fn(),
  mockCancelPrompt: vi.fn(async () => {}),
  mockPrepareChat: vi.fn(),
  mockSaveAgentConfig: vi.fn(async () => {}),
  mockInstallAcpAgent: vi.fn(async () => ({ command: 'opencode', args: ['acp'] })),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockResolvedAgents: { current: [] as readonly SupportedAcpAgentEntry[] },
  mockIsMobile: { current: false },
  // `waitForTurnClear` subscribes with (state, prevState); tests fire it.
  subscribeListeners: { current: new Set<(s: unknown, prev: unknown) => void>() },
  acpStateRef: {
    current: {} as Record<string, unknown>
  }
}))

vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: mockToastError } }))

vi.mock('@/stores/acp-store', () => {
  const state = () => ({
    ...acpStateRef.current,
    armAgentSwitch: mockArmAgentSwitch,
    setSwitchPendingOption: mockSetSwitchPendingOption,
    cancelAgentSwitch: mockCancelAgentSwitch,
    cancelPrompt: mockCancelPrompt,
    prepareChat: mockPrepareChat,
    saveAgentConfig: mockSaveAgentConfig
  })
  const useAcpStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state())
  useAcpStore.getState = state
  useAcpStore.subscribe = (listener: (s: unknown, prev: unknown) => void) => {
    subscribeListeners.current.add(listener)
    return () => {
      subscribeListeners.current.delete(listener)
    }
  }
  return { useAcpStore }
})

vi.mock('@/stores/acp-store/model-catalog', () => ({ readModelCatalog: async () => null }))

vi.mock('@/hooks/use-resolved-supported-acp-agents', () => ({
  useResolvedSupportedAcpAgents: () => mockResolvedAgents.current
}))

vi.mock('@/lib/acp-api', () => ({ acpApi: { installAcpAgent: mockInstallAcpAgent } }))

vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => mockIsMobile.current }))

const CURSOR: StoredAgentConfig = {
  id: 'acp-registry:cursor',
  configId: 'acp-registry:cursor',
  name: 'Cursor',
  command: 'cursor-agent',
  args: [],
  env: {},
  allowTerminal: false,
  templateId: 'cursor'
}

/** A ready custom agent whose registry configId differs from its stored id. */
const CLAUDE: StoredAgentConfig = {
  id: 'custom-abc12345',
  configId: 'acp-registry:claude-acp',
  name: 'Claude Agent',
  command: 'claude',
  args: [],
  env: {},
  allowTerminal: false
}

function readyEntry(config: StoredAgentConfig): SupportedAcpAgentEntry {
  return {
    id: config.id,
    configId: config.configId ?? config.id,
    agent: { id: config.id, name: config.name, version: '', description: '', distribution: {} },
    config,
    status: 'ready',
    install: null,
    manualInstall: null,
    runtimeLauncher: null,
    unavailableReason: null
  }
}

function installEntry(status: SupportedAcpAgentEntry['status'] = 'install-required') {
  return {
    id: 'opencode',
    configId: 'acp-registry:opencode',
    agent: {
      id: 'opencode',
      name: 'OpenCode',
      version: '1.0.0',
      description: '',
      distribution: {}
    },
    config: null,
    status,
    install:
      status === 'install-required'
        ? {
            kind: 'archive' as const,
            archiveUrl: 'https://example.com/oc.tgz',
            cmd: './opencode',
            args: ['acp'],
            env: {}
          }
        : null,
    manualInstall: null,
    runtimeLauncher: null,
    unavailableReason: status === 'manual-install' ? 'Install it from the vendor site' : null
  } as SupportedAcpAgentEntry
}

const CLAUDE_MODELS = {
  models: {
    currentModelId: 'opus',
    availableModels: [
      { modelId: 'opus', name: 'Claude Opus' },
      { modelId: 'haiku', name: 'Claude Haiku' }
    ]
  },
  modes: null,
  configOptions: [],
  updatedAt: 1
}

function seed(
  entries: readonly SupportedAcpAgentEntry[] = [],
  session: Record<string, unknown> = {}
): void {
  mockResolvedAgents.current = entries
  acpStateRef.current = {
    agentConfigs: [CURSOR, ...entries.flatMap((e) => (e.config ? [e.config] : []))],
    sessions: {
      'session-1': {
        agentId: 'agent-1',
        cwd: '/work',
        projectId: 'p1',
        switching: null,
        ...session
      }
    },
    configToLiveAgent: { 'acp-registry:cursor\0/work': 'agent-1' },
    sessionIndex: [],
    promptQueues: {},
    pendingPermissions: {},
    pendingQuestions: {},
    launchingSessionIds: {},
    pendingBrowserOpen: {},
    preparedSessions: {},
    preparingChatKeys: {},
    prepareChatErrors: {},
    agentOptionsCache: {}
  }
}

function option(
  id: string,
  name: string,
  category: string,
  currentValue: string,
  options: Array<{ value: string; name: string }>
): SessionConfigOption {
  return { id, name, category, type: 'select', currentValue, options }
}

function renderSelector(
  overrides: Partial<Parameters<typeof AgentModelSelector>[0]> = {}
): ReturnType<typeof render> {
  return render(
    <AgentModelSelector
      sessionId="session-1"
      disabled={false}
      busy={false}
      modelOption={option('model', 'Model', 'model', 'opus', [
        { value: 'opus', name: 'Opus 5.5' },
        { value: 'sonnet', name: 'Sonnet 5.5' }
      ])}
      modelSource="config"
      thoughtLevel={option('reasoning', 'Effort', 'thought_level', 'high', [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' }
      ])}
      fastMode={option('fast_mode', 'Fast Mode', 'other', 'off', [
        { value: 'on', name: 'On' },
        { value: 'off', name: 'Off' }
      ])}
      agentTemplateId="cursor"
      agentIcon={null}
      genericOptions={[]}
      onSetConfig={vi.fn()}
      onSetModel={vi.fn()}
      {...overrides}
    />
  )
}

function open(): void {
  fireEvent.click(screen.getByTestId('agent-model-selector-trigger'))
}

beforeEach(() => {
  vi.clearAllMocks()
  subscribeListeners.current.clear()
  mockIsMobile.current = false
  seed()
})

afterEach(() => cleanup())

describe('AgentModelSelector panel', () => {
  it('opens to the model list with search focused; a model pick keeps the panel open', () => {
    const onSetConfig = vi.fn()
    renderSelector({ onSetConfig })
    open()

    expect(screen.getByLabelText('Search models and agents')).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Opus 5.5' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Sonnet 5.5' }))

    expect(onSetConfig).toHaveBeenCalledWith('model', 'sonnet')
    // Effort levels and Fast depend on the model, so the panel stays open to
    // set them next.
    expect(screen.getByTestId('agent-model-selector-panel')).toBeInTheDocument()
  })

  it('changes effort in one click and keeps the panel open', () => {
    const onSetConfig = vi.fn()
    renderSelector({ onSetConfig })
    open()

    const effort = screen.getByRole('group', { name: 'Effort' })
    expect(within(effort).getByRole('button', { name: 'High' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    fireEvent.click(within(effort).getByRole('button', { name: 'Medium' }))

    expect(onSetConfig).toHaveBeenCalledWith('reasoning', 'medium')
    expect(screen.getByTestId('agent-model-selector-panel')).toBeInTheDocument()
  })

  it('toggles Fast with the icon toggle at the end of the effort row', () => {
    const onSetConfig = vi.fn()
    renderSelector({ onSetConfig })
    open()

    const fast = screen.getByRole('button', { name: 'Fast Mode' })
    expect(fast).toHaveAttribute('aria-pressed', 'false')
    expect(
      within(screen.getByRole('group', { name: 'Effort' })).queryByRole('button', {
        name: 'Fast Mode'
      })
    ).toBeNull()
    fireEvent.click(fast)
    expect(onSetConfig).toHaveBeenCalledWith('fast_mode', 'on')
  })

  it('fills the Fast icon in the warning color while Fast mode is on', () => {
    renderSelector({
      fastMode: option('fast_mode', 'Fast Mode', 'model_config', 'on', [
        { value: 'on', name: 'On' },
        { value: 'off', name: 'Off' }
      ])
    })
    open()

    const fast = screen.getByRole('button', { name: 'Fast Mode' })
    expect(fast).toHaveAttribute('aria-pressed', 'true')
    expect(fast).toHaveClass('text-warning')
    expect(fast.querySelector('svg')).toHaveAttribute('fill', 'currentColor')
  })

  it('shows an outline Fast icon while Fast mode is off', () => {
    renderSelector()
    open()

    const fast = screen.getByRole('button', { name: 'Fast Mode' })
    expect(fast).not.toHaveClass('text-warning')
    expect(fast.querySelector('svg')).toHaveAttribute('fill', 'none')
  })

  it('keeps the Fast slot (disabled) when the model has no Fast mode', () => {
    renderSelector({ fastMode: null })
    open()

    const fast = screen.getByRole('button', { name: 'Fast mode is not available for this model' })
    expect(fast).toBeDisabled()
  })

  it.each([
    [true, 'with Fast'],
    [false, 'without Fast']
  ])('shows six effort levels as a two-row switcher, never a dropdown (%s %s)', (withFast) => {
    const onSetConfig = vi.fn()
    const levels = ['default', 'low', 'medium', 'high', 'xhigh', 'max']
    renderSelector({
      onSetConfig,
      fastMode: withFast
        ? option('fast_mode', 'Fast Mode', 'model_config', 'off', [
            { value: 'on', name: 'On' },
            { value: 'off', name: 'Off' }
          ])
        : null,
      thoughtLevel: option(
        'effort',
        'Effort',
        'thought_level',
        'high',
        levels.map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) }))
      )
    })
    open()

    expect(screen.queryByRole('combobox')).toBeNull()
    const effort = screen.getByRole('group', { name: 'Effort' })
    expect(within(effort).getAllByRole('button')).toHaveLength(6)
    expect(effort.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))')
    fireEvent.click(within(effort).getByRole('button', { name: 'Max' }))
    expect(onSetConfig).toHaveBeenCalledWith('effort', 'max')
  })

  it('wraps five effort levels into rows of three and two that fill the width', () => {
    renderSelector({
      thoughtLevel: option(
        'effort',
        'Effort',
        'thought_level',
        'low',
        ['minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => ({ value, name: value }))
      )
    })
    open()

    const effort = screen.getByRole('group', { name: 'Effort' })
    expect(effort.style.gridTemplateColumns).toBe('repeat(6, minmax(0, 1fr))')
    const spans = within(effort)
      .getAllByRole('button')
      .map((b) => b.style.gridColumn)
    expect(spans).toEqual([
      'span 2 / span 2',
      'span 2 / span 2',
      'span 2 / span 2',
      'span 3 / span 3',
      'span 3 / span 3'
    ])
  })

  it('shows a short agent option (Cursor Context) as a labelled track', () => {
    const onSetConfig = vi.fn()
    renderSelector({
      onSetConfig,
      genericOptions: [
        option('context', 'Context', 'other', '256k', [
          { value: '256k', name: '256K' },
          { value: '500k', name: '500K' }
        ])
      ]
    })
    open()

    const context = screen.getByRole('group', { name: 'Context' })
    expect(within(context).getByRole('button', { name: '256K' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    fireEvent.click(within(context).getByRole('button', { name: '500K' }))
    expect(onSetConfig).toHaveBeenCalledWith('context', '500k')
  })

  it('shows Codex collaboration mode as "Mode" with a caption column sized to its text', () => {
    const onSetConfig = vi.fn()
    renderSelector({
      onSetConfig,
      genericOptions: [
        option('collaboration_mode', 'Collaboration mode', 'collaboration_mode', 'default', [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan' }
        ])
      ]
    })
    open()

    const mode = screen.getByRole('group', { name: 'Collaboration mode' })
    expect(within(mode).getByText('Mode')).toBeInTheDocument()
    expect(within(mode).queryByText('Collaboration mode')).toBeNull()
    // The caption takes only its text width; the values share the rest.
    expect(mode.style.gridTemplateColumns).toBe('max-content repeat(2, minmax(0, 1fr))')
    fireEvent.click(within(mode).getByRole('button', { name: 'Plan' }))
    expect(onSetConfig).toHaveBeenCalledWith('collaboration_mode', 'plan')
  })

  it('holds a boolean switch until the config set settles, then follows the store', async () => {
    let resolveSet: () => void = () => {}
    const onSetConfig = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSet = resolve
        })
    )
    renderSelector({
      onSetConfig,
      genericOptions: [
        { id: 'web_search', name: 'Web search', type: 'boolean', currentValue: false }
      ]
    })
    open()

    const toggle = screen.getByRole('switch', { name: 'Web search' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    await act(async () => {
      await Promise.resolve()
    })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await act(async () => {
      resolveSet()
    })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('reverts a boolean switch when the config set fails', async () => {
    const onSetConfig = vi.fn().mockRejectedValue(new Error('rejected'))
    renderSelector({
      onSetConfig,
      genericOptions: [
        { id: 'web_search', name: 'Web search', type: 'boolean', currentValue: false }
      ]
    })
    open()

    const toggle = screen.getByRole('switch', { name: 'Web search' })
    fireEvent.click(toggle)
    await act(async () => {
      await Promise.resolve()
    })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(onSetConfig).toHaveBeenCalledWith('web_search', true)
  })

  it('filters on search; Escape clears the search, then closes the popover', async () => {
    renderSelector()
    open()

    const search = screen.getByLabelText('Search models and agents')
    fireEvent.change(search, { target: { value: 'sonn' } })
    const list = screen.getByTestId('selector-list')
    expect(within(list).getByRole('button', { name: /Sonnet 5\.5/ })).toBeInTheDocument()
    expect(within(list).queryByRole('button', { name: /Opus 5\.5/ })).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('No models or agents match.')).toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(search).toHaveValue(''))
    expect(screen.getByTestId('agent-model-selector-panel')).toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByTestId('agent-model-selector-panel')).not.toBeInTheDocument()
    })
  })

  it('opens with the shared dropdown motion (same as the mode menu)', () => {
    renderSelector()
    open()
    expect(
      screen.getByTestId('agent-model-selector-panel').closest('[data-menu-motion]')
    ).toHaveAttribute('data-menu-motion', 'dropdown')
  })

  it('dismisses the popover on an outside pointer', async () => {
    renderSelector()
    open()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    fireEvent.pointerDown(document.body, { button: 0 })
    fireEvent.click(document.body)
    await waitFor(() => {
      expect(screen.queryByTestId('agent-model-selector-panel')).not.toBeInTheDocument()
    })
  })

  it('renders in a bottom sheet on mobile web', () => {
    mockIsMobile.current = true
    renderSelector()
    open()
    expect(screen.getByRole('dialog')).toHaveTextContent('Model and agent')
    expect(screen.getByRole('button', { name: 'Sonnet 5.5' })).toHaveClass('min-h-11')
  })

  it('renders without a crash against a partial store state', () => {
    acpStateRef.current = {}
    renderSelector()
    open()
    expect(screen.getByTestId('agent-model-selector-panel')).toBeInTheDocument()
  })
})

describe('AgentModelSelector agent tabs (switch logic moved from AgentSwitchPicker)', () => {
  it('arms by the STORE id with the model chosen on another tab', async () => {
    seed([readyEntry(CLAUDE)])
    acpStateRef.current.agentOptionsCache = { [CLAUDE.id]: CLAUDE_MODELS }
    renderSelector()
    open()

    fireEvent.click(screen.getByRole('tab', { name: 'Claude Agent' }))
    expect(screen.getByText('Switches to Claude Agent on the next send')).toBeInTheDocument()
    // The chat's own agent's options never show under another agent's tab.
    expect(screen.queryByTestId('selector-footer')).toBeNull()
    expect(
      screen.getByText('Choose a model to set Effort and Fast for Claude Agent.')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Claude Haiku' }))
    // The panel stays open so effort and Fast can be set for the new agent.
    expect(screen.getByTestId('agent-model-selector-panel')).toBeInTheDocument()

    await waitFor(() => {
      expect(mockArmAgentSwitch).toHaveBeenCalledWith('session-1', CLAUDE.id)
    })
    await waitFor(() => {
      expect(mockSetSwitchPendingOption).toHaveBeenCalledWith('session-1', { modelId: 'haiku' })
    })
  })

  it('does not save a model pick when the store rejects the arm', async () => {
    mockArmAgentSwitch.mockResolvedValueOnce(false)
    seed([readyEntry(CLAUDE)])
    acpStateRef.current.agentOptionsCache = { [CLAUDE.id]: CLAUDE_MODELS }
    renderSelector()
    open()
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Claude Haiku' }))

    await waitFor(() => expect(mockArmAgentSwitch).toHaveBeenCalled())
    expect(mockSetSwitchPendingOption).not.toHaveBeenCalled()
  })

  it('starts the agent silently when no model list is known', async () => {
    seed([readyEntry(CLAUDE)])
    renderSelector()
    open()
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Agent' }))

    expect(screen.getByText('Loading Claude Agent models…')).toBeInTheDocument()
    await waitFor(() => {
      expect(mockPrepareChat).toHaveBeenCalledWith(CLAUDE.id, '/work', undefined, 'p1', {
        silent: true
      })
    })
  })

  it('busy turn: Cancel turn and switch runs cancel → wait → arm with the model', async () => {
    seed([readyEntry(CLAUDE)], { activeTurn: true, openTurnId: 'turn-1' })
    acpStateRef.current.agentOptionsCache = { [CLAUDE.id]: CLAUDE_MODELS }
    renderSelector()
    open()
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Claude Haiku' }))

    expect(screen.getByTestId('agent-switch-busy')).toHaveTextContent(
      'Cursor is working on a turn.'
    )
    fireEvent.click(screen.getByTestId('agent-switch-cancel-then-switch'))

    await waitFor(() => expect(mockCancelPrompt).toHaveBeenCalledWith('session-1'))
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()

    const prev = acpStateRef.current.sessions
    acpStateRef.current.sessions = {
      'session-1': { agentId: 'agent-1', cwd: '/work', projectId: 'p1', switching: null }
    }
    for (const listener of subscribeListeners.current) {
      listener({ sessions: acpStateRef.current.sessions }, { sessions: prev })
    }

    await waitFor(() => {
      expect(mockArmAgentSwitch).toHaveBeenCalledWith('session-1', CLAUDE.id)
    })
    await waitFor(() => {
      expect(mockSetSwitchPendingOption).toHaveBeenCalledWith('session-1', { modelId: 'haiku' })
    })
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('Wait closes the panel and cancels or arms nothing', async () => {
    seed([readyEntry(CLAUDE)], { activeTurn: true, openTurnId: 'turn-1' })
    acpStateRef.current.agentOptionsCache = { [CLAUDE.id]: CLAUDE_MODELS }
    renderSelector()
    open()
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Claude Haiku' }))
    fireEvent.click(within(screen.getByTestId('agent-switch-busy')).getByText('Wait'))

    await waitFor(() => {
      expect(screen.queryByTestId('agent-model-selector-panel')).not.toBeInTheDocument()
    })
    expect(mockCancelPrompt).not.toHaveBeenCalled()
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()
  })

  it.each([
    ['queued prompts', { promptQueues: { 'session-1': [{ id: 'q1' }] } }, {}],
    ['a launching chat', { launchingSessionIds: { 'session-1': true } }, {}],
    ['a pending browser sign-in', { pendingBrowserOpen: { 'agent-1': 'https://x' } }, {}],
    [
      'an active turn with a queued prompt',
      { promptQueues: { 'session-1': [{ id: 'q1' }] } },
      { activeTurn: true, openTurnId: 'turn-1' }
    ]
  ])('wait-only busy (%s): only Wait, no cancel-then-switch', (_name, state, session) => {
    seed([readyEntry(CLAUDE)], session)
    Object.assign(acpStateRef.current, state)
    acpStateRef.current.agentOptionsCache = { [CLAUDE.id]: CLAUDE_MODELS }
    renderSelector()
    open()
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Claude Haiku' }))

    expect(screen.getByTestId('agent-switch-busy')).toHaveTextContent(/This chat is busy/)
    expect(screen.queryByTestId('agent-switch-cancel-then-switch')).not.toBeInTheDocument()
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()
  })

  it('installs an agent from the More list: install → save → success toast', async () => {
    seed([readyEntry(CLAUDE), installEntry()])
    // OpenCode is not ready, so it sits behind More, not in the track.
    renderSelector()
    open()

    fireEvent.click(screen.getByRole('tab', { name: 'More agents' }))
    fireEvent.click(screen.getByTestId('selector-agent-acp-registry:opencode'))
    expect(screen.getByText('OpenCode is not installed')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('agent-install-acp-registry:opencode'))

    await waitFor(() => expect(mockInstallAcpAgent).toHaveBeenCalledWith('opencode'))
    await waitFor(() => expect(mockSaveAgentConfig).toHaveBeenCalled())
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('OpenCode installed'))
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()
  })

  it('toasts on an install failure', async () => {
    mockInstallAcpAgent.mockRejectedValueOnce(new Error('network down'))
    seed([readyEntry(CLAUDE), installEntry()])
    renderSelector()
    open()
    fireEvent.click(screen.getByRole('tab', { name: 'More agents' }))
    fireEvent.click(screen.getByTestId('selector-agent-acp-registry:opencode'))
    fireEvent.click(screen.getByTestId('agent-install-acp-registry:opencode'))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Failed to install OpenCode: Error: network down')
    })
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()
  })

  it('disables a ready agent that has no stored config (the store would reject the arm)', () => {
    seed([readyEntry(CLAUDE)])
    acpStateRef.current.agentConfigs = [CURSOR]
    renderSelector()
    open()
    fireEvent.click(screen.getByRole('tab', { name: 'More agents' }))

    const row = screen.getByTestId('selector-agent-acp-registry:claude-acp')
    expect(row).toBeDisabled()
    expect(row).toHaveTextContent('Not set up')
  })

  it('shows the reason and no install button for a manual-install agent', () => {
    seed([readyEntry(CLAUDE), installEntry('manual-install')])
    renderSelector()
    open()
    fireEvent.click(screen.getByRole('tab', { name: 'More agents' }))
    fireEvent.click(screen.getByTestId('selector-agent-acp-registry:opencode'))

    expect(screen.getByText('Install it from the vendor site')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-install-acp-registry:opencode')).not.toBeInTheDocument()
  })
})
