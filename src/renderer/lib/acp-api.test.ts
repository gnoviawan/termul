import { beforeEach, describe, expect, it, vi } from 'vitest'

// Exercises the real desktop transport, not the invoke-backed double from vitest.setup.ts.
vi.unmock('@/lib/acp-transport/desktop-transport')
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
  acpAnswerQuestion,
  acpCancelPrompt,
  acpRespondPermission,
  acpSendPrompt,
  onAcpEvent,
  parseAcpErrorDetail
} from './acp-api'
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  AcpTransportError
} from './acp-transport'
import { _resetDesktopLocalEventsForTests } from './acp-transport/desktop-local-events'

describe('acp-api desktop path (Tauri context)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetAcpTransportForTests(null)
  })

  it('claims a commandId for permission and question answers like the browser (desktop speaks /ws now)', async () => {
    const respondPermission = vi.fn().mockResolvedValue(undefined)
    const answerQuestion = vi.fn().mockResolvedValue(undefined)
    _setAcpTransportForTests({ respondPermission, answerQuestion, dispose: vi.fn() } as never)

    await acpRespondPermission('agent-1', 'req-1', 'allow')
    await acpAnswerQuestion('agent-1', 'q-1', ['a'])

    expect(respondPermission).toHaveBeenCalledWith('agent-1', 'req-1', 'allow', {
      commandId: expect.any(String),
      onVisibleAt: expect.any(Function)
    })
    expect(answerQuestion).toHaveBeenCalledWith('agent-1', 'q-1', ['a'], {
      commandId: expect.any(String),
      onVisibleAt: expect.any(Function)
    })
  })

  it('propagates a rejected command untouched (non-uncertain errors end the command)', async () => {
    const rejection = new AcpTransportError('not_found', 'no such agent')
    _setAcpTransportForTests({
      cancelPrompt: vi.fn().mockRejectedValue(rejection),
      dispose: vi.fn()
    } as never)
    await expect(acpCancelPrompt('agent-1', 's1')).rejects.toBe(rejection)
  })
})

describe('onAcpEvent subscription (Tauri context)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetAcpTransportForTests(null)
    _resetDesktopLocalEventsForTests()
  })

  it('delivers desktop-local acp:worktree_progress events through a plain Tauri listener', async () => {
    const unlisten = vi.fn()
    let captured: ((e: { payload: unknown }) => void) | null = null
    ;(listen as ReturnType<typeof vi.fn>).mockImplementation(
      (_name: string, cb: (e: { payload: unknown }) => void) => {
        captured = cb
        return Promise.resolve(unlisten)
      }
    )

    const received: unknown[] = []
    const detach = onAcpEvent<{ line: string }>('acp:worktree_progress', (p) => received.push(p))

    expect(listen).toHaveBeenCalledWith('acp:worktree_progress', expect.any(Function))
    await Promise.resolve()
    ;(captured as ((e: { payload: unknown }) => void) | null)?.({ payload: { line: 'x' } })
    expect(received).toEqual([{ line: 'x' }])

    detach()
    ;(captured as ((e: { payload: unknown }) => void) | null)?.({ payload: { line: 'y' } })
    expect(received).toEqual([{ line: 'x' }])
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
      registerDiscoveredSession: vi.fn(),
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
    expect(sendPrompt).toHaveBeenCalledWith('a1', 's1', 'hi', undefined, undefined)
    expect(invoke).not.toHaveBeenCalled()
    _resetAcpTransportForTests(null)
  })
})

describe('parseAcpErrorDetail (gh-821)', () => {
  it('returns an empty detail for an old payload', () => {
    expect(parseAcpErrorDetail({ agentId: 'a1', message: 'boom' })).toEqual({})
  })

  it('extracts an integer code and data from a full payload', () => {
    expect(
      parseAcpErrorDetail({
        agentId: 'a1',
        message: 'auth',
        code: -32000,
        data: { reason: 'login' }
      })
    ).toEqual({ code: -32000, data: { reason: 'login' } })
  })

  it('extracts a known provider code and drops an unknown one', () => {
    expect(
      parseAcpErrorDetail({
        message: 'limit',
        code: -32603,
        providerCode: 'provider_session_limit'
      })
    ).toEqual({ code: -32603, providerCode: 'provider_session_limit' })
    expect(parseAcpErrorDetail({ providerCode: 'provider_quota_exceeded' })).toEqual({
      providerCode: 'provider_quota_exceeded'
    })
    expect(parseAcpErrorDetail({ providerCode: 'something_else' })).toEqual({})
    expect(parseAcpErrorDetail({ providerCode: 429 })).toEqual({})
  })

  it('ignores a non-integer code and tolerates non-object payloads', () => {
    expect(parseAcpErrorDetail({ code: 1.5 })).toEqual({})
    expect(parseAcpErrorDetail({ code: '-32000' })).toEqual({})
    expect(parseAcpErrorDetail(null)).toEqual({})
    expect(parseAcpErrorDetail('boom')).toEqual({})
  })
})
