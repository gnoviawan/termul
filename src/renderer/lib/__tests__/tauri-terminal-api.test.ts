import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.fn()
const mockListen = vi.fn()

vi.mock('@tauri-apps/api/core', () => {
  // Minimal Tauri binary Channel double: records the `onmessage` handler so
  // tests can drive streamed bytes exactly like the Rust forwarders do.
  class Channel<TMessage = ArrayBuffer> {
    onmessage: ((message: TMessage) => void) | null = null
  }
  return { invoke: mockInvoke, Channel }
})

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen
}))

describe('tauri-terminal-api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('shares one Tauri listener across multiple onExit subscribers and tears down after last unsubscribe', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}

    const unlisten = vi.fn()

    mockListen.mockResolvedValue(unlisten)

    const { createTauriTerminalApi } = await import('../tauri-terminal-api')
    const api = createTauriTerminalApi()

    const callbackA = vi.fn()
    const callbackB = vi.fn()

    const unsubscribeA = api.onExit(callbackA)
    const unsubscribeB = api.onExit(callbackB)

    await Promise.resolve()

    expect(mockListen).toHaveBeenCalledTimes(1)

    unsubscribeA()
    expect(unlisten).not.toHaveBeenCalled()

    unsubscribeB()
    await Promise.resolve()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('registers new native listener after previous shared listener fully unsubscribed', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}

    const unlistenA = vi.fn()
    const unlistenB = vi.fn()

    mockListen.mockResolvedValueOnce(unlistenA).mockResolvedValueOnce(unlistenB)

    const { createTauriTerminalApi } = await import('../tauri-terminal-api')
    const api = createTauriTerminalApi()

    const unsubscribeA = api.onExit(vi.fn())
    await Promise.resolve()
    expect(mockListen).toHaveBeenCalledTimes(1)

    unsubscribeA()
    await Promise.resolve()
    expect(unlistenA).toHaveBeenCalledTimes(1)

    const unsubscribeB = api.onExit(vi.fn())
    await Promise.resolve()
    expect(mockListen).toHaveBeenCalledTimes(2)

    unsubscribeB()
    await Promise.resolve()
    expect(unlistenB).toHaveBeenCalledTimes(1)
  })

  it('skips native listener registration outside Tauri context', async () => {
    const { createTauriTerminalApi } = await import('../tauri-terminal-api')
    const api = createTauriTerminalApi()

    const unsubscribe = api.onExit(vi.fn())
    unsubscribe()

    expect(mockListen).not.toHaveBeenCalled()
  })

  describe('CAP-3 reclaimable leases (claim issuance, attach, rotate, revoke)', () => {
    /** Load the adapter + mocked Channel class together. The dynamic imports
     * keep the vi.mock factories lazy (they only run after the module-level
     * mock fns above are initialized). */
    async function loadApi() {
      const [{ createTauriTerminalApi }, { Channel }] = await Promise.all([
        import('../tauri-terminal-api'),
        import('@tauri-apps/api/core')
      ])
      return { api: createTauriTerminalApi(), Channel }
    }

    type ChannelLike = { onmessage: ((message: ArrayBuffer) => void) | null }

    const SPAWNED = {
      id: 'terminal-1752-1',
      shell: 'pwsh',
      cwd: 'C:/dev/project',
      pid: 4242,
      cols: 120,
      rows: 32,
      claim: 'issued-claim-64-hex'
    }

    it('spawn result surfaces the issued claim alongside terminal info', async () => {
      const { api, Channel } = await loadApi()
      mockInvoke.mockResolvedValue({ success: true, data: SPAWNED })

      const result = await api.spawn({ projectId: 'p1', cols: 120, rows: 32 })

      expect(mockInvoke).toHaveBeenCalledTimes(1)
      const [command, args] = mockInvoke.mock.calls[0]
      expect(command).toBe('terminal_spawn')
      expect(args.options).toEqual({ projectId: 'p1', cols: 120, rows: 32 })
      // Output still streams through a raw binary channel (shape unchanged).
      expect(args.onData).toBeInstanceOf(Channel)

      // CAP-3: spawn is the only issuance path — the claim rides alongside
      // the terminal info fields in the same flattened camelCase shape.
      expect(result).toEqual({ success: true, data: SPAWNED })
      if (result.success) {
        expect(result.data.claim).toBe('issued-claim-64-hex')
        expect(result.data.id).toBe('terminal-1752-1')
      }
    })

    it('attach passes terminalId + claim + lastSeq + Channel to terminal_attach and streams bytes by terminal id', async () => {
      const { api, Channel } = await loadApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: {
          id: 'terminal-1752-1',
          shell: 'pwsh',
          cwd: 'C:/dev/project',
          pid: 4242,
          cols: 120,
          rows: 32,
          latestSeq: 87,
          gap: false
        }
      })

      const received: Array<{ terminalId: string; bytes: Uint8Array }> = []
      const off = api.onData((terminalId, bytes) => received.push({ terminalId, bytes }))

      const result = await api.attach('terminal-1752-1', 'lease-claim-64-hex', 12)

      expect(mockInvoke).toHaveBeenCalledTimes(1)
      const [command, args] = mockInvoke.mock.calls[0]
      expect(command).toBe('terminal_attach')
      // The credential gate: id + claim + cursor — never id-only.
      expect(args).toMatchObject({
        terminalId: 'terminal-1752-1',
        claim: 'lease-claim-64-hex',
        lastSeq: 12
      })
      expect(args.onData).toBeInstanceOf(Channel)

      // Attach result: replay cursor + gap flag in camelCase — and it NEVER
      // carries a claim (attach consumes the credential, never issues one).
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual({
          id: 'terminal-1752-1',
          shell: 'pwsh',
          cwd: 'C:/dev/project',
          pid: 4242,
          cols: 120,
          rows: 32,
          latestSeq: 87,
          gap: false
        })
        expect('claim' in result.data).toBe(false)
      }

      // Streamed bytes reach data callbacks keyed by the attached terminal id.
      const channel = args.onData as unknown as ChannelLike
      channel.onmessage?.(new Uint8Array([104, 105]).buffer)
      expect(received).toHaveLength(1)
      expect(received[0].terminalId).toBe('terminal-1752-1')
      expect(Array.from(received[0].bytes)).toEqual([104, 105])

      off()
    })

    it('never presents an id-only attach: empty claim fails without an invoke', async () => {
      const { api } = await loadApi()

      const result = await api.attach('terminal-1752-1', '', 0)

      expect(result).toEqual({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('attach failure surfaces the generic UNAUTHORIZED IpcResult error and releases the channel', async () => {
      const { api } = await loadApi()
      mockInvoke.mockResolvedValue({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })

      const received: Array<{ terminalId: string; bytes: Uint8Array }> = []
      const off = api.onData((terminalId, bytes) => received.push({ terminalId, bytes }))

      const result = await api.attach('terminal-1752-1', 'stolen-or-rotated-claim', 0)

      // The host's single generic rejection surfaces verbatim — no detail
      // distinguishing unknown terminal vs wrong/revoked claim (no leak).
      expect(result).toEqual({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })

      // The stream channel is released: a late byte can never reach callbacks.
      const channel = mockInvoke.mock.calls[0][1].onData as unknown as ChannelLike
      expect(typeof channel.onmessage).toBe('function') // swapped for a no-op
      channel.onmessage?.(new Uint8Array([1]).buffer)
      expect(received).toHaveLength(0)

      off()
    })

    it('rotateClaim invokes terminal_rotate_claim with (terminalId, claim) and returns the fresh credential', async () => {
      const { api } = await loadApi()
      mockInvoke.mockResolvedValue({ success: true, data: { claim: 'rotated-claim-64-hex' } })

      const result = await api.rotateClaim('terminal-1752-1', 'lease-claim-64-hex')

      expect(mockInvoke).toHaveBeenCalledTimes(1)
      expect(mockInvoke).toHaveBeenCalledWith('terminal_rotate_claim', {
        terminalId: 'terminal-1752-1',
        claim: 'lease-claim-64-hex'
      })
      // Possession-based rotation: the response carries the fresh credential.
      expect(result).toEqual({ success: true, data: { claim: 'rotated-claim-64-hex' } })
    })

    it('revokeClaim invokes terminal_revoke_claim with (terminalId, claim)', async () => {
      const { api } = await loadApi()
      mockInvoke.mockResolvedValue({ success: true, data: undefined })

      const result = await api.revokeClaim('terminal-1752-1', 'lease-claim-64-hex')

      expect(mockInvoke).toHaveBeenCalledTimes(1)
      expect(mockInvoke).toHaveBeenCalledWith('terminal_revoke_claim', {
        terminalId: 'terminal-1752-1',
        claim: 'lease-claim-64-hex'
      })
      expect(result).toEqual({ success: true, data: undefined })
    })
  })
})
