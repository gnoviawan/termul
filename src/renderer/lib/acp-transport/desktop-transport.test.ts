import { beforeEach, describe, expect, it, vi } from 'vitest'

// These suites exercise the real class, not the invoke-backed double from vitest.setup.ts.
vi.unmock('@/lib/acp-transport/desktop-transport')
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn()
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: (raw: unknown) => void = () => {}
  }
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }))

import { _resetDesktopLocalEventsForTests } from './desktop-local-events'
import { DesktopAcpTransport } from './desktop-transport'
import { AcpTransportError } from './types'
import { WsAcpTransport } from './ws-transport'

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.unlisten.mockReset()
  tauri.handlers.clear()
  tauri.listen.mockReset()
  tauri.listen.mockImplementation(
    async (name: string, handler: (event: { payload: unknown }) => void) => {
      tauri.handlers.set(name, handler)
      return tauri.unlisten
    }
  )
  _resetDesktopLocalEventsForTests()
})

describe('DesktopAcpTransport host-local domain commands', () => {
  it('keeps the commands with no /ws request type on Tauri invoke with their exact payloads', async () => {
    tauri.invoke.mockResolvedValue(undefined)
    const transport = new DesktopAcpTransport()

    await transport.installRegistryBinary({ agentId: 'a1' } as never)
    await transport.probeRuntime()
    await transport.probeMcpServer({ name: 'm', transport: 'stdio' } as never)
    await transport.fetchRegistrySnapshot(true)
    await transport.setTurnTimeout(30)
    await transport.setTurnIdleTimeout(null)
    await transport.setSessionNewTimeout(45)
    await transport.setSessionReopenTimeout(60)

    expect(tauri.invoke.mock.calls).toEqual([
      ['acp_install_registry_binary', { request: { agentId: 'a1' } }],
      ['acp_probe_runtime'],
      ['acp_probe_mcp_server', { server: { name: 'm', transport: 'stdio' } }],
      ['acp_fetch_registry_snapshot', { forceRefresh: true }],
      ['acp_set_turn_timeout', { secs: 30 }],
      ['acp_set_turn_idle_timeout', { secs: null }],
      ['acp_set_session_new_timeout', { secs: 45 }],
      ['acp_set_session_reopen_timeout', { secs: 60 }]
    ])
    transport.dispose()
  })
})

describe('DesktopAcpTransport history and cursors', () => {
  it('reports the Tauri store as history whatever the relay negotiates', () => {
    const transport = new DesktopAcpTransport()
    expect(transport.historyMode()).toBe('tauri_store')
    expect(new WsAcpTransport({ url: 'ws://x/ws' }).historyMode()).toBe('live_only')
    transport.dispose()
  })

  it('starts live-only when the host has no persisted cursor to offer', async () => {
    const transport = new DesktopAcpTransport()
    const parent = vi
      .spyOn(WsAcpTransport.prototype, 'fetchSessionCursor')
      .mockRejectedValueOnce(
        new AcpTransportError('unsupported', 'persisted history is unavailable')
      )

    await expect(transport.fetchSessionCursor('s1')).resolves.toEqual({
      lastSeq: 0,
      logEpoch: null
    })

    // Anything but "unsupported" is a real failure and must surface.
    parent.mockRejectedValueOnce(new AcpTransportError('closed', 'WebSocket closed'))
    await expect(transport.fetchSessionCursor('s1')).rejects.toMatchObject({ code: 'closed' })
    parent.mockRestore()
    transport.dispose()
  })
})

describe('DesktopAcpTransport desktop-local events', () => {
  it('routes acp:worktree_progress through a plain Tauri listener, never the relay', () => {
    const transport = new DesktopAcpTransport()
    const relayOnEvent = vi.spyOn(WsAcpTransport.prototype, 'onEvent')
    const seen: unknown[] = []

    const stop = transport.onEvent('acp:worktree_progress', (payload) => seen.push(payload))
    tauri.handlers.get('acp:worktree_progress')?.({ payload: { progressId: 'p1', line: 'x' } })

    expect(seen).toEqual([{ progressId: 'p1', line: 'x' }])
    expect(relayOnEvent).not.toHaveBeenCalled()
    stop()
    relayOnEvent.mockRestore()
    transport.dispose()
  })

  it('shares one native listener across subscribers and releases it with the last one', async () => {
    const transport = new DesktopAcpTransport()
    const a: unknown[] = []
    const b: unknown[] = []

    const stopA = transport.onEvent('acp:worktree_progress', (p) => a.push(p))
    const stopB = transport.onEvent('acp:worktree_progress', (p) => b.push(p))
    await Promise.resolve()
    expect(tauri.listen).toHaveBeenCalledTimes(1)

    tauri.handlers.get('acp:worktree_progress')?.({ payload: 1 })
    stopA()
    tauri.handlers.get('acp:worktree_progress')?.({ payload: 2 })
    expect(a).toEqual([1])
    expect(b).toEqual([1, 2])
    expect(tauri.unlisten).not.toHaveBeenCalled()

    stopB()
    expect(tauri.unlisten).toHaveBeenCalledTimes(1)
    transport.dispose()
  })

  it('releases the native listener even when the last subscriber leaves before listen() resolves', async () => {
    const transport = new DesktopAcpTransport()
    const stop = transport.onEvent('acp:worktree_progress', () => {})
    stop()
    await Promise.resolve()
    await Promise.resolve()
    expect(tauri.unlisten).toHaveBeenCalledTimes(1)
    transport.dispose()
  })

  it('keeps a newer subscription when an older listen() rejects after it was replaced', async () => {
    const first = Promise.withResolvers<() => void>()
    tauri.listen.mockImplementationOnce(() => first.promise)
    const transport = new DesktopAcpTransport()

    const stopFirst = transport.onEvent('acp:worktree_progress', () => {})
    stopFirst()
    const seen: unknown[] = []
    const stopSecond = transport.onEvent('acp:worktree_progress', (p) => seen.push(p))
    await Promise.resolve()

    first.reject(new Error('listen failed'))
    await Promise.resolve()
    await Promise.resolve()
    const stopThird = transport.onEvent('acp:worktree_progress', () => {})

    expect(tauri.listen).toHaveBeenCalledTimes(2)
    tauri.handlers.get('acp:worktree_progress')?.({ payload: 'live' })
    expect(seen).toEqual(['live'])
    stopSecond()
    stopThird()
    transport.dispose()
  })

  it('delivers relay events (every other acp:* name) through the inherited WS listener registry', () => {
    const transport = new DesktopAcpTransport()
    const relayOnEvent = vi.spyOn(WsAcpTransport.prototype, 'onEvent').mockReturnValue(() => {})

    transport.onEvent('acp:message_chunk', () => {})

    expect(relayOnEvent).toHaveBeenCalledWith('acp:message_chunk', expect.any(Function))
    expect(tauri.listen).not.toHaveBeenCalled()
    relayOnEvent.mockRestore()
    transport.dispose()
  })
})
