import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  acpAuthenticate,
  acpCancelPrompt,
  acpNewSession,
  acpRespondPermission,
  acpSendPrompt,
  acpSetConfigOption,
  acpSpawnAgent,
  onAcpEvent
} from './acp-api'
import { _resetAcpTransportForTests, _setAcpTransportForTests } from './acp-transport'

describe('acp-api command wrappers (Tauri transport)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Force a fresh Tauri transport so invoke mocks are used.
    _resetAcpTransportForTests(null)
  })

  it('acpSpawnAgent passes the config arg', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('agent-1')
    const config = { name: 'Gemini', command: 'gemini', args: [], env: {} }
    const id = await acpSpawnAgent(config)
    expect(invoke).toHaveBeenCalledWith('acp_spawn_agent', { config })
    expect(id).toBe('agent-1')
  })

  it('acpNewSession passes agentId, cwd, mcpServers', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ sessionId: 's1' })
    await acpNewSession('agent-1', '/home/user', [{ type: 'stdio', name: 'fs', command: 'npx' }])
    expect(invoke).toHaveBeenCalledWith('acp_new_session', {
      agentId: 'agent-1',
      cwd: '/home/user',
      mcpServers: [{ type: 'stdio', name: 'fs', command: 'npx' }]
    })
  })

  it('acpSendPrompt sends text under the text key', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue('end_turn')
    const reason = await acpSendPrompt('agent-1', 's1', 'hello')
    expect(invoke).toHaveBeenCalledWith('acp_send_prompt', {
      agentId: 'agent-1',
      sessionId: 's1',
      text: 'hello'
    })
    expect(reason).toBe('end_turn')
  })

  it('acpSetConfigOption uses configId/valueId', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue([])
    await acpSetConfigOption('agent-1', 's1', 'mode', 'code')
    expect(invoke).toHaveBeenCalledWith('acp_set_config_option', {
      agentId: 'agent-1',
      sessionId: 's1',
      configId: 'mode',
      valueId: 'code'
    })
  })

  it('acpRespondPermission forwards optionId (undefined = cancel)', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await acpRespondPermission('agent-1', 'req-1', 'allow')
    expect(invoke).toHaveBeenCalledWith('acp_respond_permission', {
      agentId: 'agent-1',
      requestId: 'req-1',
      optionId: 'allow'
    })
  })

  it('acpAuthenticate forwards agentId and methodId to acp_authenticate', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await acpAuthenticate('agent-1', 'cursor_login')
    expect(invoke).toHaveBeenCalledWith('acp_authenticate', {
      agentId: 'agent-1',
      methodId: 'cursor_login'
    })
  })

  it('acpAuthenticate propagates a rejected authenticate (provider login required)', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValue('login required')
    await expect(acpAuthenticate('agent-1', 'cursor_login')).rejects.toBe('login required')
  })

  it('propagates a rejected command (acp commands throw on Err)', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValue('boom')
    await expect(acpCancelPrompt('agent-1', 's1')).rejects.toBe('boom')
  })
})

describe('onAcpEvent subscription (Tauri transport)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetAcpTransportForTests(null)
  })

  it('subscribes to the named event and forwards payloads', async () => {
    const unlisten = vi.fn()
    let captured: ((e: { payload: unknown }) => void) | null = null
    ;(listen as ReturnType<typeof vi.fn>).mockImplementation(
      (_name: string, cb: (e: { payload: unknown }) => void) => {
        captured = cb
        return Promise.resolve(unlisten)
      }
    )

    const received: unknown[] = []
    onAcpEvent<{ x: number }>('acp:message_chunk', (p) => received.push(p))

    expect(listen).toHaveBeenCalledWith('acp:message_chunk', expect.any(Function))
    // flush the listen() promise so the unlisten is captured
    await Promise.resolve()
    ;(captured as ((e: { payload: unknown }) => void) | null)?.({ payload: { x: 1 } })
    expect(received).toEqual([{ x: 1 }])
  })

  it('early unlisten tears down once listen resolves', async () => {
    const unlisten = vi.fn()
    ;(listen as ReturnType<typeof vi.fn>).mockResolvedValue(unlisten)

    const detach = onAcpEvent('acp:agent_error', () => {})
    detach() // called before listen resolves
    await Promise.resolve()
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})

describe('acp-api web path (injected WS transport)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates sendPrompt to the injected transport', async () => {
    const sendPrompt = vi.fn().mockResolvedValue('end_turn')
    _setAcpTransportForTests({
      installRegistryBinary: vi.fn(),
      probeRuntime: vi.fn(),
      fetchRegistrySnapshot: vi.fn(),
      spawnAgent: vi.fn(),
      killAgent: vi.fn(),
      listAgents: vi.fn(),
      newSession: vi.fn(),
      loadSession: vi.fn(),
      resumeSession: vi.fn(),
      closeSession: vi.fn(),
      listSessions: vi.fn(),
      sendPrompt,
      sendPromptBlocks: vi.fn(),
      cancelPrompt: vi.fn(),
      setConfigOption: vi.fn(),
      setMode: vi.fn(),
      setModel: vi.fn(),
      respondPermission: vi.fn(),
      authenticate: vi.fn(),
      onEvent: vi.fn(() => () => undefined),
      connect: vi.fn(),
      dispose: vi.fn()
    } as never)

    const reason = await acpSendPrompt('a1', 's1', 'hi')
    expect(reason).toBe('end_turn')
    expect(sendPrompt).toHaveBeenCalledWith('a1', 's1', 'hi')
    expect(invoke).not.toHaveBeenCalled()
    _resetAcpTransportForTests(null)
  })
})
