import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

import { invoke } from '@tauri-apps/api/core'
import { useAcpStore } from './acp-store'

const FRESH = {
  agents: {},
  agentStatus: {},
  sessions: {},
  activeSessionId: null,
  messages: {},
  toolCalls: {},
  plans: {},
  commands: {},
  pendingPermissions: {}
}

function seedSession(sessionId: string, agentId: string, activeTurn = true): void {
  useAcpStore.setState({
    sessions: {
      [sessionId]: {
        id: sessionId,
        agentId,
        status: 'active',
        title: null,
        activeTurn,
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

  it('prompt_complete clears the active turn and finalizes the streaming message', () => {
    seedSession('s1', 'agent-1')
    const store = useAcpStore.getState()
    store._onMessageChunk({
      agentId: 'agent-1',
      sessionId: 's1',
      role: 'agent',
      content: { type: 'text', text: 'done' }
    })
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, s1: { ...s.sessions['s1'], activeTurn: true } }
    }))
    store._onPromptComplete({ agentId: 'agent-1', sessionId: 's1', stopReason: 'end_turn' })
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
          status: 'active',
          title: null,
          activeTurn: false,
          modes: null,
          configOptions: [],
          lastError: null,
          createdAt: 0
        },
        s2: {
          id: 's2',
          agentId: 'agent-1',
          status: 'active',
          title: null,
          activeTurn: false,
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
    // no _onPromptComplete fired; the resolved StopReason must clear the turn
    expect(useAcpStore.getState().sessions['s1'].activeTurn).toBe(false)
  })

  it('sendPrompt surfaces a max_tokens stop reason as an error note', async () => {
    seedSession('s1', 'agent-1', false)
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('max_tokens')
    await useAcpStore.getState().sendPrompt('s1', 'hello')
    expect(useAcpStore.getState().sessions['s1'].lastError).toMatch(/token limit/i)
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
      sessions: { ...s.sessions, s1: { ...s.sessions['s1'], activeTurn: true } }
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
          status: 'active',
          title: null,
          activeTurn: true,
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
})
