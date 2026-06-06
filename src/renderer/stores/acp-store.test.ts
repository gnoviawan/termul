import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))
vi.mock('@/lib/acp-agents-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-agents-persistence')>()
  return {
    ...actual,
    loadAgentConfigs: vi.fn(async () => []),
    saveAgentConfigs: vi.fn(async () => {})
  }
})
vi.mock('@/lib/acp-history-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-history-persistence')>()
  return {
    ...actual,
    loadSessionIndex: vi.fn(async () => []),
    saveSessionIndex: vi.fn(async () => {}),
    saveSessionPayload: vi.fn(async () => {}),
    loadSessionPayload: vi.fn(async () => null),
    deleteSessionPayload: vi.fn(async () => {})
  }
})
vi.mock('@/lib/acp-mcp-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-mcp-persistence')>()
  return {
    ...actual,
    loadMcpServers: vi.fn(async () => []),
    saveMcpServers: vi.fn(async () => {})
  }
})

import { invoke } from '@tauri-apps/api/core'
import {
  agentReuseKey,
  configIdFromReuseKey,
  prepareChatKey,
  selectAgentIdentity,
  selectConfigWarmState,
  useAcpStore
} from './acp-store'

const FRESH = {
  agents: {},
  agentStatus: {},
  agentConfigs: [],
  configToLiveAgent: {},
  warmingConfigs: {},
  preparedSessions: {},
  preparingChatKeys: {},
  pendingAuth: {},
  sessionIndex: [],
  mcpServers: [],
  sessions: {},
  activeSessionId: null,
  messages: {},
  toolCalls: {},
  plans: {},
  commands: {},
  pendingPermissions: {}
}

/**
 * Drain deferred turn-end callbacks (`setTimeout(0)`), which run after streamed
 * chunk handlers so macrotask-delivered chunks are not dropped.
 */
async function flushTurnEnd(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

function seedSession(sessionId: string, agentId: string, activeTurn = true): void {
  useAcpStore.setState({
    sessions: {
      [sessionId]: {
        id: sessionId,
        agentId,
        cwd: '/work',
        status: 'active',
        title: null,
        activeTurn,
        openTurnId: activeTurn ? 'seed-turn' : null,
        modes: null,
        configOptions: [],
        lastError: null,
        createdAt: Date.now()
      }
    },
    messages: { [sessionId]: [] }
  })
}

describe('acp-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAcpStore.setState(FRESH)
  })

  it('createSession records sessionId -> agentId and activates it', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: 's1' })
    const id = await useAcpStore.getState().createSession('agent-1', '/work')
    expect(id).toBe('s1')
    const session = useAcpStore.getState().sessions['s1']
    expect(session.agentId).toBe('agent-1')
    expect(useAcpStore.getState().activeSessionId).toBe('s1')
  })

  it('sendPrompt appends a user message and marks the turn active', async () => {
    seedSession('s1', 'agent-1', false)
    // never resolve, so the turn stays active for the assertion
    ;(invoke as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    void useAcpStore.getState().sendPrompt('s1', 'hi there')
    await Promise.resolve()
    const msgs = useAcpStore.getState().messages['s1']
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].blocks[0]).toEqual({ type: 'text', text: 'hi there' })
    // turn is marked active until the command resolves / prompt_complete fires
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(true)
  })

  it('rejects a second prompt while a turn is active', async () => {
    seedSession('s1', 'agent-1') // active by default
    await expect(useAcpStore.getState().sendPrompt('s1', 'again')).rejects.toThrow(
      /already in progress/
    )
  })

  it('coalesces agent message_chunk events into one streaming message', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'Hello ' }
    })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'world' }
    })
    const msgs = useAcpStore.getState().messages['s1']
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('agent')
    expect(msgs[0].streaming).toBe(true)
    expect(msgs[0].blocks[0]).toEqual({ type: 'text', text: 'Hello world' })
  })

  it('does not merge chunks of different roles', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'thought',
      content: { type: 'text', text: 'thinking' }
    })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'answer' }
    })
    const msgs = useAcpStore.getState().messages['s1']
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('thought')
    expect(msgs[1].role).toBe('agent')
  })

  it('prompt_complete clears the active turn and finalizes the streaming message', async () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'done' }
    })
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        s1: { ...s.sessions['s1'], activeTurn: true, openTurnId: 'turn' }
      }
    }))
    store._onPromptComplete({ agentId: 'agent-1', sessionId: 's1', stopReason: 'end_turn' })
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
    expect(useAcpStore.getState().messages['s1'][0].streaming).toBe(false)
  })

  it('refusal stop reason surfaces an error note', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'refusal'
    })
    expect(useAcpStore.getState().sessions['s1'].lastError).toMatch(/refused/i)
  })

  it('agent_disconnected marks the agent error and closes its sessions', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onAgentDisconnected({ agentId: 'agent-1' })
    expect(useAcpStore.getState().agentStatus['agent-1']).toBe('error')
    expect(useAcpStore.getState().sessions['s1'].status).toBe('closed')
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  it('session_closed marks only that session closed', () => {
    seedSession('s1', 'agent-1')
    seedSession('s2', 'agent-1')
    // seedSession overwrites; re-seed both
    useAcpStore.setState({
      sessions: {
        s1: {
          id: 's1',
          agentId: 'agent-1',
          cwd: '/work',
          status: 'active',
          title: null,
          activeTurn: false,
          openTurnId: null,
          modes: null,
          configOptions: [],
          lastError: null,
          createdAt: 0
        },
        s2: {
          id: 's2',
          agentId: 'agent-1',
          cwd: '/work',
          status: 'active',
          title: null,
          activeTurn: false,
          openTurnId: null,
          modes: null,
          configOptions: [],
          lastError: null,
          createdAt: 0
        }
      }
    })
    useAcpStore.getState()._onSessionClosed({ agentId: 'agent-1', sessionId: 's1' })
    expect(useAcpStore.getState().sessions['s1'].status).toBe('closed')
    expect(useAcpStore.getState().sessions['s2'].status).toBe('active')
  })

  it('permission_request is stored and respondPermission clears it', async () => {
    seedSession('s1', 'agent-1')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    useAcpStore.getState()._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'allow', name: 'Allow' }]
    })
    expect(useAcpStore.getState().pendingPermissions['req-1']).toBeTruthy()
    await useAcpStore.getState().respondPermission('req-1', 'allow')
    expect(useAcpStore.getState().pendingPermissions['req-1']).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('acp_respond_permission', {
      agentId: 'agent-1',
      requestId: 'req-1',
      optionId: 'allow'
    })
  })

  it('prompt_complete clears a pending permission for the session (C1)', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.getState()._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'allow', name: 'Allow' }]
    })
    useAcpStore.getState()._onPromptComplete({
      agentId: 'agent-1',
      sessionId: 's1',
      stopReason: 'cancelled'
    })
    expect(useAcpStore.getState().pendingPermissions['req-1']).toBeUndefined()
  })

  it('session_closed and agent_disconnected drop pending permissions (W2)', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-1' },
      options: []
    })
    store._onSessionClosed({ agentId: 'agent-1', sessionId: 's1' })
    expect(useAcpStore.getState().pendingPermissions['req-1']).toBeUndefined()

    store._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-2',
      toolCall: { toolCallId: 'tc-2' },
      options: []
    })
    store._onAgentDisconnected({ agentId: 'agent-1' })
    expect(useAcpStore.getState().pendingPermissions['req-2']).toBeUndefined()
  })

  it('respondPermission is re-entrancy safe (W3): second call is a no-op', async () => {
    seedSession('s1', 'agent-1')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    useAcpStore.getState()._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'allow', name: 'Allow' }]
    })
    const first = useAcpStore.getState().respondPermission('req-1', 'allow')
    const second = useAcpStore.getState().respondPermission('req-1', 'allow')
    await Promise.all([first, second])
    // only one backend call despite two invocations
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('sendPrompt failure clears the turn and records the error', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValue('backend boom')
    await expect(useAcpStore.getState().sendPrompt('s1', 'x')).rejects.toBeDefined()
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
    expect(useAcpStore.getState().sessions['s1'].lastError).toMatch(/boom/)
  })

  it('sendPrompt clears the turn on command resolution even with no prompt_complete event', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('end_turn')
    await useAcpStore.getState().sendPrompt('s1', 'hello')
    // no _onPromptComplete fired; the deferred safety-net must clear the turn
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  it('sendPrompt surfaces a max_tokens stop reason as an error note', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('max_tokens')
    await useAcpStore.getState().sendPrompt('s1', 'hello')
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s1'].lastError).toMatch(/token limit/i)
  })

  it('does not drop streamed chunks when the command reply wins the race', async () => {
    // Reproduces the Cursor blank-reply bug: the `acp_send_prompt` reply
    // resolves and finalizes BEFORE the streamed chunk events are processed.
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('end_turn')
    const store = useAcpStore.getState()
    // Send the prompt (marks the turn active) but do not yet await completion.
    const done = store.sendPrompt('s1', 'hi')
    await Promise.resolve()
    // Chunks stream in while the turn is active (as real events would).
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'Hi' }
    })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: ' there' }
    })
    await done
    await flushTurnEnd()
    const msgs = useAcpStore.getState().messages['s1']
    // user message + the streamed agent message (not dropped)
    const agentMsg = msgs.find((m) => m.role === 'agent')
    expect(agentMsg).toBeDefined()
    expect(agentMsg?.blocks[0]).toEqual({ type: 'text', text: 'Hi there' })
    expect(agentMsg?.streaming).toBe(false)
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  it('_onPromptComplete finalizes the turn before the deferred command reply runs', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('end_turn')
    const store = useAcpStore.getState()
    const done = store.sendPrompt('s1', 'hi')
    await Promise.resolve()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'done' }
    })
    store._onPromptComplete({ agentId: 'agent-1', sessionId: 's1', stopReason: 'end_turn' })
    expect(useAcpStore.getState().sessions['s1'].openTurnId).not.toBeNull()
    await done
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
    const agentMsg = useAcpStore.getState().messages['s1'].find((m) => m.role === 'agent')
    expect(agentMsg?.blocks[0]).toEqual({ type: 'text', text: 'done' })
    expect(agentMsg?.streaming).toBe(false)
  })

  it('coalesces chunks that arrive after the turn is finalized', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('end_turn')
    const store = useAcpStore.getState()
    const done = store.sendPrompt('s1', 'hi')
    await Promise.resolve()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'Hello' }
    })
    store._onPromptComplete({ agentId: 'agent-1', sessionId: 's1', stopReason: 'end_turn' })
    await flushTurnEnd()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: ' world' }
    })
    await done
    const agentMsg = useAcpStore.getState().messages['s1'].find((m) => m.role === 'agent')
    expect(agentMsg?.blocks[0]).toEqual({ type: 'text', text: 'Hello world' })
  })

  it('does not drop chunks when prompt_complete is processed before them', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('end_turn')
    const store = useAcpStore.getState()
    const done = store.sendPrompt('s1', 'hi')
    await Promise.resolve()
    store._onPromptComplete({ agentId: 'agent-1', sessionId: 's1', stopReason: 'end_turn' })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'Hi' }
    })
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: ' there' }
    })
    await done
    await flushTurnEnd()
    const agentMsg = useAcpStore.getState().messages['s1'].find((m) => m.role === 'agent')
    expect(agentMsg?.blocks[0]).toEqual({ type: 'text', text: 'Hi there' })
  })

  it('rejects sendPrompt on a closed session', async () => {
    seedSession('s1', 'agent-1', false)
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, s1: { ...s.sessions['s1'], status: 'closed' } }
    }))
    await expect(useAcpStore.getState().sendPrompt('s1', 'x')).rejects.toThrow(/closed/)
  })

  it('cancelPrompt is a no-op when no turn is active', async () => {
    seedSession('s1', 'agent-1', false)
    await useAcpStore.getState().cancelPrompt('s1')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('drops message_chunk for unknown session', () => {
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 'ghost',
      role: 'agent',
      content: { type: 'text', text: 'x' }
    })
    expect(useAcpStore.getState().messages['ghost']).toBeUndefined()
  })

  it('drops message_chunk for a closed session', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, s1: { ...s.sessions['s1'], status: 'closed' } }
    }))
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'late' }
    })
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)
  })

  it('does not resurrect a finalized turn with a late chunk (no active turn)', () => {
    seedSession('s1', 'agent-1', false)
    // session active:false => a chunk must not start a new message
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'late' }
    })
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)
  })

  it('ignores an empty leading text chunk', () => {
    seedSession('s1', 'agent-1')
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        s1: { ...s.sessions['s1'], activeTurn: true, openTurnId: 'turn' }
      }
    }))
    useAcpStore.getState()._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: '' }
    })
    expect(useAcpStore.getState().messages['s1']).toHaveLength(0)
  })

  it('createSession merges with a record created by an event during the await', async () => {
    // an event created a partial session with an error before createSession resolves
    useAcpStore.setState({
      sessions: {
        s1: {
          id: 's1',
          agentId: 'agent-1',
          cwd: '/work',
          status: 'active',
          title: null,
          activeTurn: true,
          openTurnId: 'turn',
          modes: null,
          configOptions: [],
          lastError: 'early error',
          createdAt: 1
        }
      }
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: 's1' })
    await useAcpStore.getState().createSession('agent-1', '/work')
    const session = useAcpStore.getState().sessions['s1']
    expect(session.lastError).toBe('early error')
    expect(session.activeTurn).toBe(true)
  })

  it('keeps an existing pending permission for a duplicate requestId', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'allow', name: 'Allow' }]
    })
    store._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 's1',
      requestId: 'req-1',
      toolCall: { toolCallId: 'tc-2' },
      options: [{ optionId: 'deny', name: 'Deny' }]
    })
    const pending = useAcpStore.getState().pendingPermissions['req-1']
    expect((pending.toolCall as { toolCallId: string }).toolCallId).toBe('tc-1')
  })

  it('saveAgentConfig adds then updates a config (P4)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'a1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    expect(useAcpStore.getState().agentConfigs).toHaveLength(1)
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'a1', name: 'Renamed', command: 'gemini', args: [], env: {} })
    expect(useAcpStore.getState().agentConfigs).toHaveLength(1)
    expect(useAcpStore.getState().agentConfigs[0].name).toBe('Renamed')
  })

  it('deleteAgentConfig removes a config (P4)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'a1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    await useAcpStore.getState().deleteAgentConfig('a1')
    expect(useAcpStore.getState().agentConfigs).toHaveLength(0)
  })

  it('prewarmAgent spawns and registers a live agent for the config+cwd (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce('agent-warm')
    await useAcpStore.getState().prewarmAgent('cfg-w', '/work')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]).toBe(
      'agent-warm'
    )
    expect(useAcpStore.getState().agentStatus['agent-warm']).toBe('connected')
  })

  it('prewarmAgent is a no-op when an empty cwd is given (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    await useAcpStore.getState().prewarmAgent('cfg-w', '   ')
    expect(invoke).not.toHaveBeenCalled()
    expect(useAcpStore.getState().configToLiveAgent).toEqual({})
  })

  it('prewarmAgent is a no-op when the config+cwd is already connected (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agentStatus: { ...s.agentStatus, 'agent-warm': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-w', '/work')]: 'agent-warm' }
    }))
    await useAcpStore.getState().prewarmAgent('cfg-w', '/work')
    expect(invoke).not.toHaveBeenCalled()
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]).toBe(
      'agent-warm'
    )
  })

  it('prewarmAgent spawns a separate process per cwd (multi-project)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('agent-a')
      .mockResolvedValueOnce('agent-b')
    await useAcpStore.getState().prewarmAgent('cfg-w', '/a')
    await useAcpStore.getState().prewarmAgent('cfg-w', '/b')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/a')]).toBe('agent-a')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/b')]).toBe('agent-b')
    const spawnCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'acp_spawn_agent'
    )
    expect(spawnCalls).toHaveLength(2)
  })

  it('prewarmAgent stays silent and leaves no mapping when spawn fails (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce('spawn boom')
    await expect(useAcpStore.getState().prewarmAgent('cfg-w', '/work')).resolves.toBeUndefined()
    expect(
      useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]
    ).toBeUndefined()
  })

  it('deleteAgentConfig clears preparedSessions for the config (GH-288)', async () => {
    const key = prepareChatKey('cfg-w', '/work', undefined)
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      preparedSessions: { ...s.preparedSessions, [key]: 'sess-prep' },
      preparingChatKeys: { ...s.preparingChatKeys, [key]: true }
    }))
    await useAcpStore.getState().deleteAgentConfig('cfg-w')
    expect(useAcpStore.getState().preparedSessions[key]).toBeUndefined()
    expect(useAcpStore.getState().preparingChatKeys[key]).toBeUndefined()
  })

  it('deleteAgentConfig kills every per-cwd process and clears their mappings (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        'agent-a': { id: 'agent-a', capabilities: null },
        'agent-b': { id: 'agent-b', capabilities: null }
      },
      agentStatus: { ...s.agentStatus, 'agent-a': 'connected', 'agent-b': 'connected' },
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('cfg-w', '/a')]: 'agent-a',
        [agentReuseKey('cfg-w', '/b')]: 'agent-b'
      }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await useAcpStore.getState().deleteAgentConfig('cfg-w')
    expect(useAcpStore.getState().agentConfigs).toHaveLength(0)
    expect(useAcpStore.getState().configToLiveAgent).toEqual({})
    expect(invoke).toHaveBeenCalledWith('acp_kill_agent', { agentId: 'agent-a' })
    expect(invoke).toHaveBeenCalledWith('acp_kill_agent', { agentId: 'agent-b' })
  })

  it('killAgent drops any configToLiveAgent entry pointing at it (GH-288)', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-warm': { id: 'agent-warm', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-warm': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-w', '/work')]: 'agent-warm' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    await useAcpStore.getState().killAgent('agent-warm')
    expect(
      useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]
    ).toBeUndefined()
  })

  it('disable while warming kills the spawned agent, leaving no orphan (GH-288 C1)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    // Spawn resolves later, simulating the slow `npx` warm-up window.
    let resolveSpawn!: (id: string) => void
    const spawnGate = new Promise<string>((r) => {
      resolveSpawn = r
    })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(spawnGate) // acp_spawn_agent (warm)
      .mockResolvedValueOnce(undefined) // acp_kill_agent
    const warm = useAcpStore.getState().prewarmAgent('cfg-w', '/work')
    expect(useAcpStore.getState().warmingConfigs[agentReuseKey('cfg-w', '/work')]).toBe(true)
    // Disable before the spawn resolves; deleteAgentConfig must await the warm.
    const del = useAcpStore.getState().deleteAgentConfig('cfg-w')
    resolveSpawn('agent-orphan')
    await Promise.all([warm, del])
    expect(useAcpStore.getState().agentConfigs).toHaveLength(0)
    expect(
      useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]
    ).toBeUndefined()
    expect(useAcpStore.getState().warmingConfigs[agentReuseKey('cfg-w', '/work')]).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('acp_kill_agent', { agentId: 'agent-orphan' })
  })

  it('concurrent prewarmAgent calls for the same cwd spawn only one process (GH-288 C2)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce('agent-warm')
    await Promise.all([
      useAcpStore.getState().prewarmAgent('cfg-w', '/work'),
      useAcpStore.getState().prewarmAgent('cfg-w', '/work')
    ])
    const spawnCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'acp_spawn_agent'
    )
    expect(spawnCalls).toHaveLength(1)
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-w', '/work')]).toBe(
      'agent-warm'
    )
  })

  it('startChat awaits an in-flight warm instead of re-spawning (GH-288 C3)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-w', name: 'Gemini', command: 'gemini', args: [], env: {} })
    let resolveSpawn!: (id: string) => void
    const spawnGate = new Promise<string>((r) => {
      resolveSpawn = r
    })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(spawnGate) // acp_spawn_agent (warm)
      .mockResolvedValueOnce({ sessionId: 'sess-warm' }) // acp_new_session (reuse)
    const warm = useAcpStore.getState().prewarmAgent('cfg-w', '/work')
    const chat = useAcpStore.getState().startChat('cfg-w', '/work')
    resolveSpawn('agent-warm')
    const [, sessionId] = await Promise.all([warm, chat])
    expect(sessionId).toBe('sess-warm')
    const spawnCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'acp_spawn_agent'
    )
    expect(spawnCalls).toHaveLength(1)
    expect(useAcpStore.getState().sessions['sess-warm'].agentId).toBe('agent-warm')
  })

  it('startChat spawns a configured agent then creates a session (P4)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('agent-9')
      .mockResolvedValueOnce({ sessionId: 'sess-9' })
    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/work')
    expect(sessionId).toBe('sess-9')
    expect(useAcpStore.getState().sessions['sess-9'].agentId).toBe('agent-9')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-1', '/work')]).toBe(
      'agent-9'
    )
  })

  it('startChat reuses a prepared session from prepareChat (GH-288)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-9': { id: 'agent-9', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-9': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-prep' })
    useAcpStore.getState().prepareChat('cfg-1', '/work')
    await vi.waitFor(() => {
      expect(Object.values(useAcpStore.getState().preparedSessions).includes('sess-prep')).toBe(
        true
      )
    })
    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/work')
    expect(sessionId).toBe('sess-prep')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('acp_new_session', {
      agentId: 'agent-9',
      cwd: '/work',
      mcpServers: undefined
    })
  })

  it('startChat reuses a connected agent instead of re-spawning (P4)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-9': { id: 'agent-9', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-9': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessionId: 'sess-2' })
    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/work')
    expect(sessionId).toBe('sess-2')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('acp_new_session', {
      agentId: 'agent-9',
      cwd: '/work',
      mcpServers: undefined
    })
  })

  it('testConnection spawns then always kills the test process (P4)', async () => {
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('agent-test')
      .mockResolvedValueOnce(undefined)
    // Pre-seed capabilities so the capability wait resolves immediately
    // (the acp:agent_spawned listener isn't wired in the test).
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        'agent-test': { id: 'agent-test', capabilities: { loadSession: true } }
      }
    }))
    const caps = await useAcpStore
      .getState()
      .testConnection({ name: 'X', command: 'x', args: [], env: {} })
    expect(caps).toEqual({ loadSession: true })
    expect(invoke).toHaveBeenNthCalledWith(1, 'acp_spawn_agent', {
      config: { name: 'X', command: 'x', args: [], env: {} }
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'acp_kill_agent', { agentId: 'agent-test' })
    expect(useAcpStore.getState().agents['agent-test']).toBeUndefined()
  })

  it('openHistorySession loads the local transcript when no agent is connected (P5)', async () => {
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-old',
        agentId: 'agent-x',
        title: 'Old chat',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }],
          streaming: false,
          timestamp: 0
        }
      ]
    })
    await useAcpStore.getState().openHistorySession('s-old')
    // no agent connected -> 'local' strategy: transcript is shown, no IPC call
    expect(invoke).not.toHaveBeenCalled()
    expect(useAcpStore.getState().messages['s-old']).toHaveLength(1)
    expect(useAcpStore.getState().sessions['s-old'].status).toBe('closed')
  })

  it('openHistorySession leaves a live session untouched (P5)', async () => {
    // The session is already running in a pane with messages in memory; reopening
    // it from history must not reload or wipe the live transcript.
    seedSession('s-live', 'agent-1', true)
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      messages: {
        ...s.messages,
        's-live': [
          {
            id: 'live-1',
            role: 'agent',
            blocks: [{ type: 'text', text: 'streaming' }],
            streaming: false,
            timestamp: 0
          }
        ]
      }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    await useAcpStore.getState().openHistorySession('s-live')
    // Fast path: no disk read, no reload IPC; live transcript preserved.
    expect(loadSessionPayload).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(useAcpStore.getState().messages['s-live']).toHaveLength(1)
    expect(useAcpStore.getState().messages['s-live'][0].id).toBe('live-1')
  })

  it('openHistorySession still reloads when session is cached but closed (P5)', async () => {
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' },
      sessions: {
        's-closed': {
          id: 's-closed',
          agentId: 'agent-1',
          cwd: '/w',
          status: 'closed',
          title: 'Was open',
          activeTurn: false,
          openTurnId: null,
          modes: null,
          configOptions: [],
          lastError: null,
          createdAt: 1
        }
      },
      messages: { 's-closed': [] }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-closed',
        agentId: 'agent-1',
        title: 'Was open',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm1',
          role: 'user',
          blocks: [{ type: 'text', text: 'from disk' }],
          streaming: false,
          timestamp: 0
        }
      ]
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
    await useAcpStore.getState().openHistorySession('s-closed')
    expect(loadSessionPayload).toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('acp_load_session', {
      agentId: 'agent-1',
      sessionId: 's-closed',
      cwd: '/w'
    })
    // load strategy clears then agent replays; with no replay, messages stay empty
    expect(useAcpStore.getState().messages['s-closed']).toEqual([])
    expect(useAcpStore.getState().sessions['s-closed'].status).toBe('active')
  })

  it('openHistorySession restores the local transcript if load fails (P5)', async () => {
    // A non-live session whose agent process is still connected with loadSession
    // -> 'load' strategy; if the reload fails the local transcript is restored.
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-1': { id: 'agent-1', capabilities: { loadSession: true } } },
      agentStatus: { ...s.agentStatus, 'agent-1': 'connected' }
    }))
    const { loadSessionPayload } = await import('@/lib/acp-history-persistence')
    ;(loadSessionPayload as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      metadata: {
        id: 's-load',
        agentId: 'agent-1',
        title: 'Reloadable',
        cwd: '/w',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      },
      messages: [
        {
          id: 'm1',
          role: 'user',
          blocks: [{ type: 'text', text: 'prior' }],
          streaming: false,
          timestamp: 0
        }
      ]
    })
    // acp_load_session rejects
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce('load boom')
    await expect(useAcpStore.getState().openHistorySession('s-load')).rejects.toBeDefined()
    // transcript was restored (not left empty) and the error surfaced
    expect(useAcpStore.getState().messages['s-load']).toHaveLength(1)
    expect(useAcpStore.getState().sessions['s-load'].lastError).toMatch(/Resume failed/)
  })

  it('deleteHistorySession removes the index entry (P5)', async () => {
    useAcpStore.setState({
      sessionIndex: [
        {
          id: 's1',
          agentId: 'a',
          title: 'T',
          cwd: '',
          createdAt: 0,
          lastActivityAt: 0,
          messageCount: 0,
          status: 'closed'
        }
      ]
    })
    await useAcpStore.getState().deleteHistorySession('s1')
    expect(useAcpStore.getState().sessionIndex).toHaveLength(0)
  })

  it('MCP registry CRUD persists and removes (P6)', async () => {
    await useAcpStore
      .getState()
      .saveMcpServer({ id: 'm1', type: 'stdio', name: 'fs', command: 'npx' })
    expect(useAcpStore.getState().mcpServers).toHaveLength(1)
    await useAcpStore
      .getState()
      .saveMcpServer({ id: 'm1', type: 'stdio', name: 'fs2', command: 'npx' })
    expect(useAcpStore.getState().mcpServers).toHaveLength(1)
    expect(useAcpStore.getState().mcpServers[0].name).toBe('fs2')
    await useAcpStore.getState().deleteMcpServer('m1')
    expect(useAcpStore.getState().mcpServers).toHaveLength(0)
  })

  it('startChat forwards selected MCP servers to new_session (P6)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('agent-9')
      .mockResolvedValueOnce({ sessionId: 'sess-9' })
    const servers = [{ type: 'stdio' as const, name: 'fs', command: 'npx' }]
    await useAcpStore.getState().startChat('cfg-1', '/work', servers)
    expect(invoke).toHaveBeenNthCalledWith(2, 'acp_new_session', {
      agentId: 'agent-9',
      cwd: '/work',
      mcpServers: servers
    })
  })
})

describe('acp-store multi-project isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAcpStore.setState(FRESH)
  })

  it('agentReuseKey/configIdFromReuseKey round-trip a config id with cwd', () => {
    const key = agentReuseKey('acp-registry:claude-acp', '/work/a')
    expect(key).toBe('acp-registry:claude-acp\0/work/a')
    expect(configIdFromReuseKey(key)).toBe('acp-registry:claude-acp')
  })

  it('startChat in a second project spawns a separate process, not reusing project A', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    // Project A already has a live, connected process.
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-a': { id: 'agent-a', capabilities: null } },
      agentStatus: { ...s.agentStatus, 'agent-a': 'connected' },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/a')]: 'agent-a' }
    }))
    // Launch the same agent in project B (different cwd) -> spawns a new process.
    ;(invoke as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('agent-b')
      .mockResolvedValueOnce({ sessionId: 'sess-b' })
    const sessionId = await useAcpStore.getState().startChat('cfg-1', '/b')
    expect(sessionId).toBe('sess-b')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-1', '/a')]).toBe('agent-a')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-1', '/b')]).toBe('agent-b')
    const spawnCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'acp_spawn_agent'
    )
    expect(spawnCalls).toHaveLength(1)
  })

  it('a disconnect of one project process leaves the other project session active', () => {
    // Two live processes for the same config, one per project. seedSession
    // replaces the whole sessions map, so set both records in a single update.
    const mkSession = (id: string, agentId: string, cwd: string) => ({
      id,
      agentId,
      cwd,
      status: 'active' as const,
      title: null,
      activeTurn: false,
      openTurnId: null,
      modes: null,
      configOptions: [],
      lastError: null,
      createdAt: Date.now()
    })
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        's-a': mkSession('s-a', 'agent-a', '/a'),
        's-b': mkSession('s-b', 'agent-b', '/b')
      },
      agentStatus: { ...s.agentStatus, 'agent-a': 'connected', 'agent-b': 'connected' },
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('cfg-1', '/a')]: 'agent-a',
        [agentReuseKey('cfg-1', '/b')]: 'agent-b'
      }
    }))
    // Project A's process dies.
    useAcpStore.getState()._onAgentDisconnected({ agentId: 'agent-a' })
    expect(useAcpStore.getState().sessions['s-a'].status).toBe('closed')
    expect(useAcpStore.getState().agentStatus['agent-a']).toBe('error')
    // Project B is untouched.
    expect(useAcpStore.getState().sessions['s-b'].status).toBe('active')
    expect(useAcpStore.getState().agentStatus['agent-b']).toBe('connected')
    expect(useAcpStore.getState().configToLiveAgent[agentReuseKey('cfg-1', '/b')]).toBe('agent-b')
  })

  it('selectAgentIdentity resolves the config behind a per-cwd live agent', async () => {
    await useAcpStore.getState().saveAgentConfig({
      id: 'cfg-1',
      templateId: 'claude-acp',
      name: 'Claude',
      command: 'claude',
      args: [],
      env: {}
    })
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/b')]: 'agent-b' }
    }))
    const identity = selectAgentIdentity(useAcpStore.getState(), 'agent-b')
    expect(identity).toEqual({ name: 'Claude', templateId: 'claude-acp' })
  })

  it('selectConfigWarmState rolls up status across all per-cwd processes', () => {
    useAcpStore.setState((s) => ({
      agentStatus: { ...s.agentStatus, 'agent-a': 'needs-auth', 'agent-b': 'connected' },
      configToLiveAgent: {
        ...s.configToLiveAgent,
        [agentReuseKey('cfg-1', '/a')]: 'agent-a',
        [agentReuseKey('cfg-1', '/b')]: 'agent-b'
      },
      warmingConfigs: { ...s.warmingConfigs, [agentReuseKey('cfg-1', '/c')]: true }
    }))
    const state = selectConfigWarmState(useAcpStore.getState(), 'cfg-1')
    expect(state).toEqual({ connected: true, needsAuth: true, warming: true })
    // A different config sees nothing.
    expect(selectConfigWarmState(useAcpStore.getState(), 'cfg-other')).toEqual({
      connected: false,
      needsAuth: false,
      warming: false
    })
  })
})
