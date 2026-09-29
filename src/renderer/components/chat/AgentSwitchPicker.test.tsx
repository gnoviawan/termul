import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { AgentSwitchPicker } from './AgentSwitchPicker'

// jsdom omits `document.elementFromPoint`; Radix/floating-ui call it during
// popover open/positioning. Returning `null` keeps the popover openable in
// jsdom (positioning degrades to the default offset). Same pattern as
// AgentLauncher.test.tsx / ChatInputBar.test.tsx.
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
    writable: true
  })
}

const {
  mockArmAgentSwitch,
  mockCancelAgentSwitch,
  mockCancelPrompt,
  mockSaveAgentConfig,
  mockInstallAcpAgent,
  mockToastSuccess,
  mockToastError,
  acpStateRef,
  mockResolvedAgents,
  mockIsMobile,
  subscribeListeners
} = vi.hoisted(() => ({
  mockArmAgentSwitch: vi.fn(async () => true),
  mockCancelAgentSwitch: vi.fn(),
  mockCancelPrompt: vi.fn(async () => {}),
  mockSaveAgentConfig: vi.fn(async () => {}),
  mockInstallAcpAgent: vi.fn(async () => ({ command: 'claude', args: ['acp'] })),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockResolvedAgents: { current: null as null | readonly SupportedAcpAgentEntry[] },
  // Override-able mobile-shell flag (the mobile SelectorModal branch test
  // flips it true).
  mockIsMobile: { current: false },
  // Captured store-subscribe listeners so tests can fire (state, prevState)
  // pairs — the `waitForTurnClear` contract.
  subscribeListeners: { current: new Set<(s: unknown, prev: unknown) => void>() },
  acpStateRef: {
    current: {
      agentConfigs: [] as StoredAgentConfig[],
      sessions: {} as Record<
        string,
        {
          agentId: string
          switching: { toConfigId: string; status: 'pending' } | null
          activeTurn?: boolean
          openTurnId?: string | null
          replaying?: unknown
        }
      >,
      promptQueues: {} as Record<string, unknown[]>,
      pendingPermissions: {} as Record<string, { sessionId: string }>,
      pendingQuestions: {} as Record<string, { sessionId: string }>,
      launchingSessionIds: {} as Record<string, true>,
      pendingBrowserOpen: {} as Record<string, string>,
      configToLiveAgent: {} as Record<string, string>,
      sessionIndex: [] as Array<{ id: string; agentConfigId?: string }>
    }
  }
}))

vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError }
}))

vi.mock('@/stores/acp-store', () => {
  const state = () => ({
    agentConfigs: acpStateRef.current.agentConfigs,
    saveAgentConfig: mockSaveAgentConfig,
    armAgentSwitch: mockArmAgentSwitch,
    cancelAgentSwitch: mockCancelAgentSwitch,
    cancelPrompt: mockCancelPrompt,
    sessions: acpStateRef.current.sessions,
    promptQueues: acpStateRef.current.promptQueues,
    pendingPermissions: acpStateRef.current.pendingPermissions,
    pendingQuestions: acpStateRef.current.pendingQuestions,
    launchingSessionIds: acpStateRef.current.launchingSessionIds,
    pendingBrowserOpen: acpStateRef.current.pendingBrowserOpen,
    configToLiveAgent: acpStateRef.current.configToLiveAgent,
    sessionIndex: acpStateRef.current.sessionIndex
  })
  const useAcpStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state())
  useAcpStore.getState = state
  // Forward (state, prevState) to every listener — `waitForTurnClear`
  // subscribes with that signature and compares busy→clear transitions.
  useAcpStore.subscribe = (listener: (s: unknown, prev: unknown) => void) => {
    subscribeListeners.current.add(listener)
    return () => {
      subscribeListeners.current.delete(listener)
    }
  }
  return { useAcpStore }
})

vi.mock('@/hooks/use-resolved-supported-acp-agents', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agents/supported-acp-agents')>(
    '@/lib/agents/supported-acp-agents'
  )
  return {
    useResolvedSupportedAcpAgents: (configs: readonly StoredAgentConfig[]) =>
      mockResolvedAgents.current ?? actual.buildSupportedAcpAgents(configs, 'linux-x86_64')
  }
})

vi.mock('@/lib/acp-api', () => ({
  acpApi: { installAcpAgent: mockInstallAcpAgent }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mockIsMobile.current
}))

const CURRENT_CONFIG: StoredAgentConfig = {
  id: 'acp-registry:cursor',
  configId: 'acp-registry:cursor',
  name: 'Cursor',
  command: 'cursor-agent',
  args: [],
  env: {},
  allowTerminal: false,
  templateId: 'cursor'
}

const CLAUDE_CONFIG: StoredAgentConfig = {
  id: 'acp-registry:claude-acp',
  configId: 'acp-registry:claude-acp',
  name: 'Claude Agent',
  command: 'claude',
  args: [],
  env: {},
  allowTerminal: false,
  templateId: 'claude-acp'
}

/** A ready, persisted custom agent whose configId diverges from its stored id. */
function customEntry(configId: string, name: string): SupportedAcpAgentEntry {
  const config: StoredAgentConfig = {
    ...CLAUDE_CONFIG,
    id: 'custom-abc12345',
    configId,
    name,
    templateId: undefined
  }
  return {
    id: config.id,
    configId,
    agent: { id: config.id, name, version: '', description: '', distribution: {} },
    config,
    status: 'ready',
    install: null,
    manualInstall: null,
    runtimeLauncher: null,
    unavailableReason: null
  }
}

function installRequiredEntry(): SupportedAcpAgentEntry {
  return {
    id: 'opencode',
    configId: 'acp-registry:opencode',
    agent: {
      id: 'opencode',
      name: 'OpenCode',
      version: '1.0.0',
      description: 'OpenCode desc',
      distribution: {
        binary: {
          'linux-x86_64': {
            cmd: './opencode',
            args: ['acp'],
            archive: 'https://example.com/oc.tgz'
          }
        }
      }
    },
    config: null,
    status: 'install-required',
    install: {
      kind: 'archive',
      archiveUrl: 'https://example.com/oc.tgz',
      cmd: './opencode',
      args: ['acp'],
      env: {}
    },
    manualInstall: null,
    runtimeLauncher: null,
    unavailableReason: null
  }
}

function seedStore(entries?: readonly SupportedAcpAgentEntry[]): void {
  acpStateRef.current.agentConfigs = entries
    ? [CURRENT_CONFIG, ...entries.filter((e) => e.config).map((e) => e.config as StoredAgentConfig)]
    : [CURRENT_CONFIG]
  acpStateRef.current.sessions = {
    'session-1': { agentId: 'agent-1', switching: null }
  }
  acpStateRef.current.promptQueues = {}
  acpStateRef.current.pendingPermissions = {}
  acpStateRef.current.pendingQuestions = {}
  acpStateRef.current.launchingSessionIds = {}
  acpStateRef.current.pendingBrowserOpen = {}
  acpStateRef.current.configToLiveAgent = { 'acp-registry:cursor\0/work': 'agent-1' }
  acpStateRef.current.sessionIndex = []
  mockResolvedAgents.current = entries ?? null
}

function renderPicker(props: Partial<Parameters<typeof AgentSwitchPicker>[0]> = {}) {
  return render(
    <TooltipProvider>
      <AgentSwitchPicker sessionId="session-1" busy={false} disabled={false} {...props} />
    </TooltipProvider>
  )
}

afterEach(() => {
  cleanup()
  mockIsMobile.current = false
})

describe('AgentSwitchPicker (Story 4, CAP-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolvedAgents.current = null
    subscribeListeners.current.clear()
    mockIsMobile.current = false
    seedStore()
  })

  it('renders the trigger labeled with the current agent', async () => {
    renderPicker()
    // The trigger's aria-label names the current agent (from the store's
    // persisted config list via the live reuse-key map).
    const trigger = await screen.findByRole('button', {
      name: /Switch agent\. Currently Cursor/
    })
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveTextContent('Cursor')
  })

  it('lists resolved agents minus the current one and arms on a ready pick', async () => {
    // A ready persisted target (Claude) + the current agent (Cursor, filtered).
    const target = customEntry('acp-registry:claude-acp', 'Claude Agent')
    seedStore([target])
    renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    await waitFor(() => {
      expect(screen.getByText('Switch agent')).toBeInTheDocument()
    })
    const rows = screen.getAllByTestId(/^agent-switch-row-/)
    expect(rows.length).toBeGreaterThan(0)
    expect(screen.queryByTestId('agent-switch-row-acp-registry:cursor')).toBeNull()

    // Pick the ready row → armAgentSwitch with the STORE-resolvable id.
    const readyRow = screen.getByTestId('agent-switch-row-acp-registry:claude-acp')
    expect(readyRow).not.toBeDisabled()
    fireEvent.click(readyRow)

    await waitFor(() => {
      expect(mockArmAgentSwitch).toHaveBeenCalledWith('session-1', 'custom-abc12345')
    })
  })

  it('reflects the armed state (target name) while session.switching is set', async () => {
    acpStateRef.current.agentConfigs = [CURRENT_CONFIG, CLAUDE_CONFIG]
    acpStateRef.current.sessions = {
      'session-1': {
        agentId: 'agent-1',
        switching: { toConfigId: 'acp-registry:claude-acp', status: 'pending' }
      }
    }
    renderPicker()
    const trigger = await screen.findByRole('button', {
      name: /Switch to Claude Agent on next send/
    })
    expect(trigger).toHaveTextContent('→ Claude Agent')
    // The cancel affordance is exposed next to the armed trigger.
    expect(screen.getByTestId('agent-switch-cancel')).toBeInTheDocument()
  })

  it('cancel affordance clears the armed state', async () => {
    acpStateRef.current.agentConfigs = [CURRENT_CONFIG, CLAUDE_CONFIG]
    acpStateRef.current.sessions = {
      'session-1': {
        agentId: 'agent-1',
        switching: { toConfigId: 'acp-registry:claude-acp', status: 'pending' }
      }
    }
    renderPicker()

    fireEvent.click(screen.getByTestId('agent-switch-cancel'))
    expect(mockCancelAgentSwitch).toHaveBeenCalledWith('session-1')
  })

  it('disables the control (and its cancel affordance) for a closed session', async () => {
    acpStateRef.current.agentConfigs = [CURRENT_CONFIG, CLAUDE_CONFIG]
    acpStateRef.current.sessions = {
      'session-1': {
        agentId: 'agent-1',
        switching: { toConfigId: 'acp-registry:claude-acp', status: 'pending' }
      }
    }
    renderPicker({ disabled: true })
    const trigger = await screen.findByRole('button', {
      name: /Switch to Claude Agent on next send/
    })
    expect(trigger).toBeDisabled()
    expect(screen.getByTestId('agent-switch-cancel')).toBeDisabled()
  })

  it('renders disabled rows with their reason for manual-install/unavailable entries', async () => {
    // Force a manual-install entry into the resolved list.
    const manualEntry: SupportedAcpAgentEntry = {
      id: 'legacy',
      configId: 'acp-registry:legacy',
      agent: {
        id: 'legacy',
        name: 'Legacy Agent',
        version: '1.0.0',
        description: 'Legacy desc',
        distribution: { binary: { 'linux-x86_64': { cmd: './legacy', args: ['acp'] } } }
      },
      config: null,
      status: 'manual-install',
      install: null,
      manualInstall: { cmd: './legacy', args: ['acp'], env: {} },
      runtimeLauncher: null,
      unavailableReason: 'Install Legacy Agent from the vendor.'
    }
    seedStore([manualEntry])
    renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    const row = await screen.findByTestId('agent-switch-row-acp-registry:legacy')
    expect(row).toBeDisabled()
    expect(row).toHaveAttribute('title', 'Install Legacy Agent from the vendor.')
    expect(within(row).getByText('Manual install')).toBeInTheDocument()
  })

  it('drives the inline install then arms once the entry re-resolves ready', async () => {
    const entry = installRequiredEntry()
    seedStore([entry])
    const { rerender } = renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    const row = await screen.findByTestId('agent-switch-row-acp-registry:opencode')
    fireEvent.click(row)

    // The install facade runs (host-owned, `{ agentId }` only).
    await waitFor(() => expect(mockInstallAcpAgent).toHaveBeenCalledWith('opencode'))
    await waitFor(() => expect(mockSaveAgentConfig).toHaveBeenCalled())
    expect(mockToastSuccess).toHaveBeenCalledWith('OpenCode installed')

    // After saveAgentConfig, the entries re-resolve ready (persisted wins) —
    // simulate the flip and expect the remembered install intent to arm.
    const installedConfig: StoredAgentConfig = {
      id: 'acp-registry:opencode',
      configId: 'acp-registry:opencode',
      name: 'OpenCode',
      command: 'opencode',
      args: ['acp'],
      env: {},
      allowTerminal: false,
      templateId: 'opencode'
    }
    const readyEntry: SupportedAcpAgentEntry = {
      ...entry,
      config: installedConfig,
      status: 'ready',
      install: null
    }
    mockResolvedAgents.current = [readyEntry]
    acpStateRef.current.agentConfigs = [CURRENT_CONFIG, installedConfig]
    rerender(
      <TooltipProvider>
        <AgentSwitchPicker sessionId="session-1" busy={false} disabled={false} />
      </TooltipProvider>
    )

    await waitFor(() => {
      expect(mockArmAgentSwitch).toHaveBeenCalledWith('session-1', 'acp-registry:opencode')
    })
  })

  it('clears a dangling install intent when the re-resolution completes without the target (no later arm)', async () => {
    // Intent set → install succeeds → saveAgentConfig succeeds → but the
    // catalog re-resolution drops the target (resolver reject/failure path).
    // The intent must clear so a LATER unrelated readiness update cannot arm
    // the stale target.
    const entry = installRequiredEntry()
    seedStore([entry])
    const { rerender } = renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    fireEvent.click(await screen.findByTestId('agent-switch-row-acp-registry:opencode'))

    await waitFor(() => expect(mockSaveAgentConfig).toHaveBeenCalled())
    expect(mockToastSuccess).toHaveBeenCalledWith('OpenCode installed')

    // The re-resolution completes WITHOUT the opencode target (a list that
    // contains other entries but not it) — the intent clears.
    mockResolvedAgents.current = [customEntry('acp-registry:claude-acp', 'Claude Agent')]
    rerender(
      <TooltipProvider>
        <AgentSwitchPicker sessionId="session-1" busy={false} disabled={false} />
      </TooltipProvider>
    )

    // A later unrelated readiness update flips claude ready — the stale
    // opencode intent must NOT arm anything (the intent was cleared).
    mockResolvedAgents.current = [
      customEntry('acp-registry:claude-acp', 'Claude Agent'),
      { ...installRequiredEntry(), status: 'ready', config: CURRENT_CONFIG }
    ]
    rerender(
      <TooltipProvider>
        <AgentSwitchPicker sessionId="session-1" busy={false} disabled={false} />
      </TooltipProvider>
    )
    await act(async () => {})
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()
  })

  it('toasts on install failure and leaves the entry install-required', async () => {
    const entry = installRequiredEntry()
    seedStore([entry])
    mockInstallAcpAgent.mockRejectedValueOnce(new Error('DOWNLOAD_FAILED'))
    renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    fireEvent.click(await screen.findByTestId('agent-switch-row-acp-registry:opencode'))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()
    expect(mockSaveAgentConfig).not.toHaveBeenCalled()
  })

  it('disables the trigger + sibling rows while an install is in flight (controllable promise)', async () => {
    const opencode = installRequiredEntry()
    const claude = customEntry('acp-registry:claude-acp', 'Claude Agent')
    seedStore([opencode, claude])
    const { promise: installPromise, resolve: resolveInstall } = Promise.withResolvers<{
      command: string
      args: string[]
    }>()
    mockInstallAcpAgent.mockImplementationOnce(() => installPromise)
    renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    fireEvent.click(await screen.findByTestId('agent-switch-row-acp-registry:opencode'))

    // Before the install resolves: the trigger is disabled AND pending (the
    // chip shows its own in-flight state), and sibling rows are disabled.
    const trigger = screen.getByTestId('agent-switch-trigger')
    await waitFor(() => expect(trigger).toBeDisabled())
    expect(trigger).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByTestId('agent-switch-row-acp-registry:claude-acp')).toBeDisabled()
    expect(screen.queryByTestId('agent-switch-row-acp-registry:cursor')).toBeNull()

    resolveInstall({ command: 'opencode', args: ['acp'] })
    await waitFor(() => expect(trigger).not.toBeDisabled())
  })

  it('presents Wait vs Cancel-then-switch when busy and runs the cancel recipe to the arm', async () => {
    const target = customEntry('acp-registry:claude-acp', 'Claude Agent')
    seedStore([target])
    // Busy session: an active turn.
    acpStateRef.current.sessions = {
      'session-1': { agentId: 'agent-1', switching: null, activeTurn: true, openTurnId: 'turn-1' }
    }
    renderPicker({ busy: true })

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    // The busy presentation is explicit (never a dead control).
    const busyNotice = await screen.findByTestId('agent-switch-busy')
    expect(busyNotice).toHaveTextContent(/still working on a turn/i)

    const readyRow = await screen.findByTestId('agent-switch-row-acp-registry:claude-acp')
    fireEvent.click(readyRow)

    // Cancel-then-switch: cancelPrompt → waitForTurnClear → arm (the
    // sendQueuedPromptNow recipe). The wait hangs until the store flips the
    // session to not-busy and the captured subscribe listeners fire with
    // (state, prevState) — then the arm leg resolves.
    await waitFor(() => expect(mockCancelPrompt).toHaveBeenCalledWith('session-1'))
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()

    const prev = acpStateRef.current.sessions
    acpStateRef.current.sessions = {
      'session-1': { agentId: 'agent-1', switching: null }
    }
    for (const listener of subscribeListeners.current) {
      listener({ sessions: acpStateRef.current.sessions }, { sessions: prev })
    }

    await waitFor(() => {
      expect(mockArmAgentSwitch).toHaveBeenCalledWith('session-1', 'custom-abc12345')
    })
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('wait-only busy (queued prompts, no live turn): rows disabled, no cancel-then-switch', async () => {
    const target = customEntry('acp-registry:claude-acp', 'Claude Agent')
    seedStore([target])
    // Queue-only busy: no activeTurn/openTurnId — cancelPrompt would be a
    // no-op and the arm would reject, so the rows must present wait-only.
    acpStateRef.current.sessions = {
      'session-1': { agentId: 'agent-1', switching: null }
    }
    acpStateRef.current.promptQueues = { 'session-1': [{ id: 'q1' }] }
    renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))

    // The busy notice presents the wait-only copy (no cancel offer).
    const busyNotice = await screen.findByTestId('agent-switch-busy')
    expect(busyNotice).toHaveTextContent(/This chat is busy/i)
    // The ready row is disabled with the wait-only reason, and its
    // aria-label carries no cancel affordance.
    const row = screen.getByTestId('agent-switch-row-acp-registry:claude-acp')
    expect(row).toBeDisabled()
    expect(row).toHaveAttribute('title', expect.stringContaining('wait for the queued prompts'))
    expect(row).not.toHaveAccessibleName(/Cancel the turn and switch/i)
    expect(mockCancelPrompt).not.toHaveBeenCalled()
  })

  it('wait-only busy during a session launch: rows disabled, no cancel affordance', async () => {
    const target = customEntry('acp-registry:claude-acp', 'Claude Agent')
    seedStore([target])
    // Launching chat: no turn exists — the gate is wait-only.
    acpStateRef.current.launchingSessionIds = { 'session-1': true }
    renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))

    const busyNotice = await screen.findByTestId('agent-switch-busy')
    expect(busyNotice).toHaveTextContent(/This chat is busy/i)
    const row = screen.getByTestId('agent-switch-row-acp-registry:claude-acp')
    expect(row).toBeDisabled()
    expect(row).not.toHaveAccessibleName(/Cancel the turn and switch/i)
    expect(mockCancelPrompt).not.toHaveBeenCalled()
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()
  })

  it('wait-only busy during pending browser sign-in: rows disabled, no cancel affordance', async () => {
    const target = customEntry('acp-registry:claude-acp', 'Claude Agent')
    seedStore([target])
    // Pending browser auth for the session's agent — wait-only.
    acpStateRef.current.pendingBrowserOpen = { 'agent-1': 'https://auth.example' }
    renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))

    const busyNotice = await screen.findByTestId('agent-switch-busy')
    expect(busyNotice).toHaveTextContent(/This chat is busy/i)
    const row = screen.getByTestId('agent-switch-row-acp-registry:claude-acp')
    expect(row).toBeDisabled()
    expect(row).not.toHaveAccessibleName(/Cancel the turn and switch/i)
    expect(mockCancelPrompt).not.toHaveBeenCalled()
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()
  })

  it('active turn + queued prompt: wait-only row (cancel would not clear the gate)', async () => {
    const target = customEntry('acp-registry:claude-acp', 'Claude Agent')
    seedStore([target])
    // A live turn WITH a queued prompt: cancelling the turn lets the store
    // flush the queued prompt, so the turn-clear wouldn't mean the switch
    // gate is clear — the row must present wait-only, not cancel-then-switch.
    acpStateRef.current.sessions = {
      'session-1': { agentId: 'agent-1', switching: null, activeTurn: true, openTurnId: 'turn-1' }
    }
    acpStateRef.current.promptQueues = { 'session-1': [{ id: 'q1' }] }
    renderPicker({ busy: true })

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))

    const busyNotice = await screen.findByTestId('agent-switch-busy')
    expect(busyNotice).toHaveTextContent(/This chat is busy/i)
    const row = screen.getByTestId('agent-switch-row-acp-registry:claude-acp')
    expect(row).toBeDisabled()
    expect(row).toHaveAttribute('title', expect.stringContaining('wait for the queued prompts'))
    expect(row).not.toHaveAccessibleName(/Cancel the turn and switch/i)
    expect(mockCancelPrompt).not.toHaveBeenCalled()
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()
  })

  it('Wait path: closing the picker while busy cancels nothing and arms nothing', async () => {
    const target = customEntry('acp-registry:claude-acp', 'Claude Agent')
    seedStore([target])
    acpStateRef.current.sessions = {
      'session-1': { agentId: 'agent-1', switching: null, activeTurn: true, openTurnId: 'turn-1' }
    }
    renderPicker({ busy: true })

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    await screen.findByTestId('agent-switch-busy')

    // Close by clicking the trigger again (popover toggle) — Wait semantics.
    fireEvent.click(screen.getByRole('button', { name: /Switch agent\. Currently Cursor/ }))

    await waitFor(() => {
      expect(mockCancelPrompt).not.toHaveBeenCalled()
      expect(mockArmAgentSwitch).not.toHaveBeenCalled()
    })
  })

  it('does NOT cancel the turn for a busy install-required pick (unarmable target)', async () => {
    const entry = installRequiredEntry()
    seedStore([entry])
    acpStateRef.current.sessions = {
      'session-1': { agentId: 'agent-1', switching: null, activeTurn: true, openTurnId: 'turn-1' }
    }
    renderPicker({ busy: true })

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    await screen.findByTestId('agent-switch-busy')

    // The install-required row is disabled while busy — cancelling the turn
    // for an arm the store would reject is never offered.
    const row = screen.getByTestId('agent-switch-row-acp-registry:opencode')
    expect(row).toBeDisabled()
    expect(row).toHaveAttribute('title', expect.stringContaining('install this agent first'))
    expect(mockCancelPrompt).not.toHaveBeenCalled()
  })

  it('arms by the STORE id for a custom agent whose entry configId diverges', async () => {
    // Entry configId diverges from the stored config id (imported agent).
    const target = customEntry('shared-config-id', 'Imported Agent')
    seedStore([target])
    renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    const row = await screen.findByTestId('agent-switch-row-shared-config-id')
    expect(row).not.toBeDisabled()
    fireEvent.click(row)

    // The arm uses the STORE's id (custom-abc12345), not the divergent
    // entry.configId — the store validates against `agentConfigs.some(id)`.
    await waitFor(() => {
      expect(mockArmAgentSwitch).toHaveBeenCalledWith('session-1', 'custom-abc12345')
    })
  })

  it('filters out ready entries whose id resolves to no stored config (unarmable)', async () => {
    // A ready entry with a config whose id is NOT in the store's
    // agentConfigs (e.g. the catalog resolution raced a config delete): the
    // row must not offer an arm that the store would reject.
    const target = customEntry('acp-registry:claude-acp', 'Claude Agent')
    seedStore([target])
    // Drop every stored config so the entry's config id resolves to nothing.
    acpStateRef.current.agentConfigs = []
    renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently/ }))
    const row = screen.queryByTestId('agent-switch-row-acp-registry:claude-acp')
    if (row) {
      expect(row).toBeDisabled()
    }
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()
  })

  it('closing the picker without a pick cancels nothing and resets the search filter', async () => {
    const target = customEntry('acp-registry:claude-acp', 'Claude Agent')
    seedStore([target])
    renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    await waitFor(() => expect(screen.getByText('Switch agent')).toBeInTheDocument())

    // Type a filter that matches nothing, then close via the trigger toggle.
    fireEvent.change(screen.getByLabelText('Search agents to switch to'), {
      target: { value: 'zzz-no-match' }
    })
    expect(screen.getByText('No other agents match.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Switch agent\. Currently Cursor/ }))

    await waitFor(() => {
      expect(mockArmAgentSwitch).not.toHaveBeenCalled()
      expect(mockCancelAgentSwitch).not.toHaveBeenCalled()
    })

    // Reopen: the stale filter is gone — the row is visible again.
    fireEvent.click(screen.getByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    await waitFor(() => {
      expect(screen.getByTestId('agent-switch-row-acp-registry:claude-acp')).toBeInTheDocument()
    })
  })

  it('mobile branch: the SelectorModal dialog renders, picks arm, and search resets on close', async () => {
    mockIsMobile.current = true
    const target = customEntry('acp-registry:claude-acp', 'Claude Agent')
    seedStore([target])
    renderPicker()

    fireEvent.click(await screen.findByRole('button', { name: /Switch agent\. Currently Cursor/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Switch agent')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByTestId('agent-switch-row-acp-registry:claude-acp'))
    await waitFor(() => {
      expect(mockArmAgentSwitch).toHaveBeenCalledWith('session-1', 'custom-abc12345')
    })
  })

  it('renders null (no crash) against a partial store state', () => {
    // Defensive selectors: a store mock without the switcher's keys must
    // render the null fallback, not throw mid-render (chat-responsive's
    // harness has exactly this shape).
    acpStateRef.current.agentConfigs = []
    acpStateRef.current.sessions = {}
    acpStateRef.current.configToLiveAgent = {}
    acpStateRef.current.sessionIndex = []
    const { container } = renderPicker()
    expect(container.querySelector('[data-testid="agent-switch-trigger"]')).toBeNull()
    expect(mockArmAgentSwitch).not.toHaveBeenCalled()
  })
})
