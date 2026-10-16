import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCommandEngineForTesting, AWAITED_RESEND_DELAYS_MS } from '@/lib/command-engine'
import { __clearCommandJournalForTesting } from '@/lib/command-journal'
import { mockPreservedPty, mockSpawnedTerminal } from '@/lib/test-utils/terminal'

const { mockInvoke, mockListen } = vi.hoisted(() => ({ mockInvoke: vi.fn(), mockListen: vi.fn() }))

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
    __clearCommandJournalForTesting()
    __resetCommandEngineForTesting()
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

    const SPAWNED = mockSpawnedTerminal({
      id: 'terminal-1752-1',
      shell: 'pwsh',
      cwd: 'C:/dev/project',
      pid: 4242,
      cols: 120,
      rows: 32,
      claim: 'issued-claim-64-hex'
    })

    // Attach-result wire shape pinned by the `toEqual` assertion below — the
    // payload deliberately carries no `snapshot`/`claim` fields (attach
    // consumes the credential, never issues one).
    const ATTACHED = {
      id: 'terminal-1752-1',
      shell: 'pwsh',
      cwd: 'C:/dev/project',
      pid: 4242,
      cols: 120,
      rows: 32,
      latestSeq: 87,
      gap: false
    }

    it('spawn result surfaces the issued claim alongside terminal info', async () => {
      const { api, Channel } = await loadApi()
      mockInvoke.mockResolvedValue({ success: true, data: SPAWNED })

      const result = await api.spawn({ projectId: 'p1', cols: 120, rows: 32 })

      expect(mockInvoke).toHaveBeenCalledTimes(1)
      const [command, args] = mockInvoke.mock.calls[0]
      expect(command).toBe('terminal_spawn')
      expect(args.options).toEqual({
        projectId: 'p1',
        cols: 120,
        rows: 32,
        commandId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/)
      })
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

    it('spawn refused by a host terminal cap surfaces TERMINAL_LIMIT with the numbers and releases the channel', async () => {
      const { api } = await loadApi()
      const refusal = {
        success: false,
        error: 'Terminal limit reached (10 per project, 30 total): this project is at its limit',
        code: 'TERMINAL_LIMIT'
      }
      mockInvoke.mockResolvedValue(refusal)

      const received: Uint8Array[] = []
      const off = api.onData((_terminalId, bytes) => received.push(bytes))
      const result = await api.spawn({ projectId: 'p1' })

      // The host's typed refusal reaches the caller verbatim: stable code,
      // message naming both limits.
      expect(result).toEqual(refusal)

      // No terminal exists, so the stream channel is released.
      const channel = mockInvoke.mock.calls[0][1].onData as unknown as ChannelLike
      channel.onmessage?.(new Uint8Array([1]).buffer)
      expect(received).toHaveLength(0)

      off()
    })

    it('attach passes terminalId + claim + lastSeq + Channel to terminal_attach and streams bytes by terminal id', async () => {
      const { api, Channel } = await loadApi()
      mockInvoke.mockResolvedValue({ success: true, data: ATTACHED })

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
        expect(result.data).toEqual(ATTACHED)
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

    it('attach forwards the epoch with the cursor, and sends an untrusted marker for a nonzero cursor without one', async () => {
      const { api } = await loadApi()
      mockInvoke.mockResolvedValue({ success: true, data: ATTACHED })

      await api.attach('terminal-1752-1', 'lease-claim-64-hex', 12, 'epoch-1')
      expect(mockInvoke.mock.calls[0][1]).toMatchObject({ lastSeq: 12, logEpoch: 'epoch-1' })

      await api.attach('terminal-1752-1', 'lease-claim-64-hex', 12)
      expect(mockInvoke.mock.calls[1][1]).toMatchObject({ lastSeq: 12, logEpoch: '' })

      await api.attach('terminal-1752-1', 'lease-claim-64-hex', 0)
      expect(mockInvoke.mock.calls[2][1].logEpoch).toBeUndefined()
    })

    it('attach clears the terminal before a reset replay and keeps replay order', async () => {
      const { api } = await loadApi()
      // The host streams the replay through the channel before the result resolves.
      mockInvoke.mockImplementation(async (_command: string, args: { onData: ChannelLike }) => {
        args.onData.onmessage?.(new Uint8Array([97]).buffer)
        args.onData.onmessage?.(new Uint8Array([98]).buffer)
        return { success: true, data: { ...ATTACHED, reset: true, logEpoch: 'epoch-2' } }
      })
      const received: number[][] = []
      const off = api.onData((_id, bytes) => received.push(Array.from(bytes)))

      await api.attach('terminal-1752-1', 'lease-claim-64-hex', 500)

      // RIS (ESC c) first, then the whole replay in order.
      expect(received).toEqual([[0x1b, 0x63], [97], [98]])
      off()
    })

    it('attach without a reset delivers the replay as-is', async () => {
      const { api } = await loadApi()
      mockInvoke.mockImplementation(async (_command: string, args: { onData: ChannelLike }) => {
        args.onData.onmessage?.(new Uint8Array([97]).buffer)
        return { success: true, data: { ...ATTACHED, reset: false, logEpoch: 'epoch-2' } }
      })
      const received: number[][] = []
      const off = api.onData((_id, bytes) => received.push(Array.from(bytes)))

      await api.attach('terminal-1752-1', 'lease-claim-64-hex', 12)

      expect(received).toEqual([[97]])
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
        claim: 'lease-claim-64-hex',
        commandId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/)
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
        claim: 'lease-claim-64-hex',
        commandId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/)
      })
      expect(result).toEqual({ success: true, data: undefined })
    })

    it('a reloaded renderer lists the live PTY and reattaches to it with the fresh claim, spawning nothing', async () => {
      const { api } = await loadApi()
      const preserved = mockPreservedPty({
        id: 'terminal-1752-1',
        shell: 'pwsh',
        cwd: 'C:/dev/project',
        claim: 'reissued-claim-64-hex',
        hasLiveAttachment: false
      })
      mockInvoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
        if (command === 'terminal_list_preserved') return { success: true, data: [preserved] }
        if (command === 'terminal_attach') {
          ;(args.onData as unknown as ChannelLike).onmessage?.(new Uint8Array([111, 107]).buffer)
          return { success: true, data: ATTACHED }
        }
        throw new Error(`unexpected command ${command}`)
      })
      const received: Array<{ terminalId: string; bytes: number[] }> = []
      const off = api.onData((terminalId, bytes) =>
        received.push({ terminalId, bytes: Array.from(bytes) })
      )

      const listed = await api.listPreserved('project-a')
      if (!listed.success) throw new Error(listed.error)
      const attached = await api.attach(listed.data[0].id, listed.data[0].claim ?? '', 0)

      expect(listed.data).toEqual([preserved])
      expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
        'terminal_list_preserved',
        'terminal_attach'
      ])
      expect(mockInvoke.mock.calls[0][1]).toEqual({ projectId: 'project-a' })
      expect(mockInvoke.mock.calls[1][1]).toMatchObject({
        terminalId: 'terminal-1752-1',
        claim: 'reissued-claim-64-hex',
        lastSeq: 0
      })
      expect(attached).toEqual({ success: true, data: ATTACHED })
      expect(received).toEqual([{ terminalId: 'terminal-1752-1', bytes: [111, 107] }])

      off()
    })

    it('listPreserved surfaces a host refusal as a failed result', async () => {
      const { api } = await loadApi()
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'missing projectId',
        code: 'VALIDATION_ERROR'
      })

      const result = await api.listPreserved('')

      expect(result).toEqual({
        success: false,
        error: 'missing projectId',
        code: 'VALIDATION_ERROR'
      })
    })

    it('outcome_unknown from a spawn resend surfaces as a failure and is never resent', async () => {
      const { api } = await loadApi()
      mockInvoke.mockRejectedValue('outcome_unknown: no longer known')

      const result = await api.spawn({ projectId: 'p1' })

      expect(result).toMatchObject({ success: false, code: 'OUTCOME_UNKNOWN' })
      expect(mockInvoke).toHaveBeenCalledTimes(1)
    })

    it('a spawn resent in-call (reply lost / first run still going) keeps its id, drops the new Channel and attaches with the fresh claim', async () => {
      vi.useFakeTimers()
      try {
        const { api, Channel } = await loadApi()
        mockInvoke
          .mockRejectedValueOnce('command_in_progress: still running')
          .mockResolvedValueOnce({ success: true, data: { ...SPAWNED, claim: 'fresh-claim' } })
          .mockResolvedValueOnce({ success: true, data: ATTACHED })
        const pending = api.spawn({ projectId: 'p1', cwd: '/w' })
        await vi.advanceTimersByTimeAsync(AWAITED_RESEND_DELAYS_MS[0])
        const result = await pending

        const [first, resend, attach] = mockInvoke.mock.calls
        expect(resend[1].options.commandId).toBe(first[1].options.commandId)
        expect(attach[0]).toBe('terminal_attach')
        expect(attach[1]).toMatchObject({
          terminalId: SPAWNED.id,
          claim: 'fresh-claim',
          lastSeq: 0
        })
        expect(attach[1].onData).toBeInstanceOf(Channel)
        expect(attach[1].onData).not.toBe(resend[1].onData)
        expect(result).toEqual({ success: true, data: { ...SPAWNED, claim: 'fresh-claim' } })
      } finally {
        vi.useRealTimers()
      }
    })

    it('a NEW spawn after an uncertain one is a new intent: it gets a different id (never the old PTY)', async () => {
      vi.useFakeTimers()
      try {
        const { api } = await loadApi()
        mockInvoke.mockRejectedValue('command_in_progress: still running')
        const first = api.spawn({ projectId: 'p1', cwd: '/w' })
        for (const delay of AWAITED_RESEND_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay)
        await expect(first).resolves.toMatchObject({ success: false, code: 'COMMAND_IN_PROGRESS' })
        const firstId = mockInvoke.mock.calls[0][1].options.commandId

        mockInvoke.mockReset()
        mockInvoke.mockResolvedValue({ success: true, data: SPAWNED })
        await api.spawn({ projectId: 'p1', cwd: '/w' })
        expect(mockInvoke.mock.calls[0][1].options.commandId).not.toBe(firstId)
      } finally {
        vi.useRealTimers()
      }
    })

    it('kill sends a well-formed commandId; a desktop write sends none (no lost-reply window, no ledger flood)', async () => {
      const { api } = await loadApi()
      mockInvoke.mockResolvedValue({ success: true, data: undefined })

      await api.kill('terminal-1752-1')
      await api.write('terminal-1752-1', 'ls\r')

      expect(mockInvoke).toHaveBeenNthCalledWith(1, 'terminal_kill', {
        terminalId: 'terminal-1752-1',
        commandId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/)
      })
      expect(mockInvoke).toHaveBeenNthCalledWith(2, 'terminal_write', {
        terminalId: 'terminal-1752-1',
        data: 'ls\r'
      })
    })

    it('a spawn the host refused mints a NEW id on the next try', async () => {
      const { api } = await loadApi()
      mockInvoke.mockResolvedValue({ success: false, error: 'no shell', code: 'SPAWN_FAILED' })
      await api.spawn({ projectId: 'p1' })
      await api.spawn({ projectId: 'p1' })
      const ids = mockInvoke.mock.calls.map(
        ([, args]) => (args as { options: { commandId: string } }).options.commandId
      )
      expect(ids).toHaveLength(2)
      expect(ids[1]).not.toBe(ids[0])
    })

    it('a spawn whose invoke rejects reports INVOKE_ERROR and mints a NEW id on the next try', async () => {
      const { api } = await loadApi()
      mockInvoke.mockRejectedValue(new Error('no such command'))
      const first = await api.spawn({ projectId: 'p1' })
      await api.spawn({ projectId: 'p1' })
      expect(first).toMatchObject({ success: false, code: 'INVOKE_ERROR' })
      const ids = mockInvoke.mock.calls.map(
        ([, args]) => (args as { options: { commandId: string } }).options.commandId
      )
      expect(ids).toHaveLength(2)
      expect(ids[1]).not.toBe(ids[0])
    })
  })
})
