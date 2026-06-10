import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  acpCancelPrompt,
  acpNewSession,
  acpRespondPermission,
  acpSendPrompt,
  acpSetConfigOption,
  acpSetSessionModel,
  acpSpawnAgent,
  onAcpEvent
} from './acp-api'

describe('acp-api command wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('acpSetSessionModel forwards modelId', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await acpSetSessionModel('agent-1', 's1', 'anthropic/claude-sonnet')
    expect(invoke).toHaveBeenCalledWith('acp_set_session_model', {
      agentId: 'agent-1',
      sessionId: 's1',
      modelId: 'anthropic/claude-sonnet'
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

  it('propagates a rejected command (acp commands throw on Err)', async () => {
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValue('boom')
    await expect(acpCancelPrompt('agent-1', 's1')).rejects.toBe('boom')
  })
})

describe('onAcpEvent subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
