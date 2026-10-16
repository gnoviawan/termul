import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalStore } from '@/stores/terminal-store'
import { flushDetachedOutputNow, useTerminalDetachedOutput } from './use-terminal-detached-output'

const {
  mockOnData,
  mockOnExit,
  mockAppendTranscript,
  mockFindTerminalByPtyId,
  mockLogFrontendError
} = vi.hoisted(() => ({
  mockOnData: vi.fn(),
  mockOnExit: vi.fn(),
  mockAppendTranscript: vi.fn(),
  mockFindTerminalByPtyId: vi.fn(),
  mockLogFrontendError: vi.fn()
}))

/** Convert a string to Uint8Array for binary channel test data */
function toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

vi.mock('@/lib/api', () => ({
  terminalApi: {
    onData: mockOnData,
    onExit: mockOnExit
  }
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

vi.mock('@/stores/terminal-store', () => ({
  MAX_TRANSCRIPT_CHARS: 1_500_000,
  useTerminalStore: {
    getState: vi.fn(() => ({
      appendTranscript: mockAppendTranscript,
      findTerminalByPtyId: mockFindTerminalByPtyId
    })),
    subscribe: vi.fn(() => vi.fn())
  }
}))

describe('useTerminalDetachedOutput', () => {
  // Deterministic animation-frame harness: the hook coalesces chunks and
  // flushes on the next rAF, so tests capture scheduled frame callbacks and
  // run them manually instead of relying on host frame timing.
  let originalRaf: typeof globalThis.requestAnimationFrame
  let originalCancelRaf: typeof globalThis.cancelAnimationFrame
  let scheduled: Map<number, FrameRequestCallback>
  let cancelledHandles: number[]
  let nextHandle: number

  beforeEach(() => {
    vi.clearAllMocks()
    mockFindTerminalByPtyId.mockReturnValue({ rendererAttachmentCount: 0, isAppHidden: false })
    originalRaf = globalThis.requestAnimationFrame
    originalCancelRaf = globalThis.cancelAnimationFrame
    scheduled = new Map()
    cancelledHandles = []
    nextHandle = 1
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      const handle = nextHandle++
      scheduled.set(handle, cb)
      return handle
    }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((handle: number): void => {
      cancelledHandles.push(handle)
      scheduled.delete(handle)
    }) as typeof cancelAnimationFrame
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf
    globalThis.cancelAnimationFrame = originalCancelRaf
  })

  /** Run every currently scheduled animation frame callback exactly once. */
  function runScheduledFrames(): void {
    const callbacks = [...scheduled.values()]
    scheduled.clear()
    for (const cb of callbacks) cb(0)
  }

  interface TerminalRecord {
    rendererAttachmentCount?: number
    isAppHidden?: boolean
  }

  /** Mount the hook and return helpers to emit PTY chunks, unmount, and read
   * the `onData` unsubscribe (to pin that teardown always detaches). */
  function mountHook(): {
    unmount: () => void
    emit: (ptyId: string, data: string) => void
    emitBytes: (ptyId: string, bytes: number[]) => void
    exit: (ptyId: string) => void
    unsubscribe: ReturnType<typeof vi.fn>
    unsubscribeExit: ReturnType<typeof vi.fn>
  } {
    let capturedCallback: ((ptyId: string, data: Uint8Array) => void) | undefined
    let capturedExit: ((ptyId: string, exitCode: number) => void) | undefined
    const unsubscribe = vi.fn()
    const unsubscribeExit = vi.fn()
    mockOnData.mockImplementation((callback: (ptyId: string, data: Uint8Array) => void) => {
      capturedCallback = callback
      return unsubscribe
    })
    mockOnExit.mockImplementation((callback: (ptyId: string, exitCode: number) => void) => {
      capturedExit = callback
      return unsubscribeExit
    })
    const { unmount } = renderHook(() => useTerminalDetachedOutput())
    return {
      unmount,
      emit: (ptyId: string, data: string) => capturedCallback?.(ptyId, toBytes(data)),
      emitBytes: (ptyId: string, bytes: number[]) =>
        capturedCallback?.(ptyId, Uint8Array.from(bytes)),
      exit: (ptyId: string) => capturedExit?.(ptyId, 0),
      unsubscribe,
      unsubscribeExit
    }
  }

  it('captures PTY output into transcript when no renderer is mounted', () => {
    const { unmount, emit } = mountHook()

    emit('pty-a', 'streaming output')
    runScheduledFrames()

    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', 'streaming output')

    unmount()
  })

  it('flushDetachedOutputNow drains a buffered detached chunk before the frame fires', () => {
    const { unmount, emit } = mountHook()

    emit('pty-a', 'late chunk')
    expect(mockAppendTranscript).not.toHaveBeenCalled()

    // A renderer attaches before the frame: the chunk must still reach the
    // transcript now, so the remount reads it in order.
    mockFindTerminalByPtyId.mockReturnValue({ rendererAttachmentCount: 1, isAppHidden: false })
    flushDetachedOutputNow()

    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', 'late chunk')
    // The scheduled frame was cancelled and finds nothing left to flush.
    runScheduledFrames()
    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)

    unmount()
  })

  it('flushDetachedOutputNow is a no-op once the hook unmounts', () => {
    const { unmount, emit } = mountHook()
    emit('pty-a', 'drained on unmount')
    unmount()
    mockAppendTranscript.mockClear()

    expect(() => flushDetachedOutputNow()).not.toThrow()
    expect(mockAppendTranscript).not.toHaveBeenCalled()
  })

  it('skips transcript capture for visible terminals with an attached renderer', () => {
    mockFindTerminalByPtyId.mockReturnValue({ rendererAttachmentCount: 1, isAppHidden: false })
    const { emit } = mountHook()

    emit('pty-a', 'visible output')
    runScheduledFrames()

    expect(mockAppendTranscript).not.toHaveBeenCalled()
    // No frame was ever scheduled — attached renderers short-circuit capture.
    expect(scheduled.size).toBe(0)
  })

  it('does not capture PTY output when app is hidden but a renderer is still attached', () => {
    mockFindTerminalByPtyId.mockReturnValue({ rendererAttachmentCount: 1, isAppHidden: true })
    const { emit } = mountHook()

    emit('pty-a', 'hidden output')
    runScheduledFrames()

    // Transcript is only for detached terminals (project switch).
    // When a renderer IS attached, data flows through xterm naturally
    // and will resume when the app becomes visible again.
    expect(mockAppendTranscript).not.toHaveBeenCalled()
  })

  it('ignores empty terminal-data payloads', () => {
    const { emit } = mountHook()

    emit('pty-a', '')
    runScheduledFrames()

    expect(mockAppendTranscript).not.toHaveBeenCalled()
    expect(scheduled.size).toBe(0)
  })

  it('ignores data for unknown PTY (store record missing)', () => {
    mockFindTerminalByPtyId.mockReturnValue(undefined)
    const { emit } = mountHook()

    emit('pty-x', 'late data')
    runScheduledFrames()

    expect(mockAppendTranscript).not.toHaveBeenCalled()
    // Unknown-PTY data stays buffered without scheduling a frame flush.
    expect(scheduled.size).toBe(0)
  })

  it('coalesces multiple chunks for one ptyId into one appendTranscript per frame', () => {
    const { emit } = mountHook()

    emit('pty-a', 'chunk-1 ')
    emit('pty-a', 'chunk-2 ')
    emit('pty-a', 'chunk-3')

    // Nothing appended until the frame flush runs.
    expect(mockAppendTranscript).not.toHaveBeenCalled()
    // Exactly one frame was requested for the whole burst.
    expect(scheduled.size).toBe(1)

    runScheduledFrames()

    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', 'chunk-1 chunk-2 chunk-3')
  })

  it('flushes one appendTranscript per ptyId when several terminals stream in the same frame', () => {
    const { emit } = mountHook()

    emit('pty-a', 'a1')
    emit('pty-b', 'b1')
    emit('pty-a', 'a2')
    emit('pty-b', 'b2')
    emit('pty-c', 'c1')

    runScheduledFrames()

    expect(mockAppendTranscript).toHaveBeenCalledTimes(3)
    expect(mockAppendTranscript).toHaveBeenNthCalledWith(1, 'pty-a', 'a1a2')
    expect(mockAppendTranscript).toHaveBeenNthCalledWith(2, 'pty-b', 'b1b2')
    expect(mockAppendTranscript).toHaveBeenNthCalledWith(3, 'pty-c', 'c1')
  })

  it('starts a new frame flush for chunks arriving after a completed flush', () => {
    const { emit } = mountHook()

    emit('pty-a', 'first ')
    runScheduledFrames()
    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)

    // Next burst lands in the next frame, not retroactively merged.
    emit('pty-a', 'second')
    expect(scheduled.size).toBe(1)
    runScheduledFrames()

    expect(mockAppendTranscript).toHaveBeenCalledTimes(2)
    expect(mockAppendTranscript).toHaveBeenLastCalledWith('pty-a', 'second')
  })

  it('drains buffered chunks synchronously on unmount so no chunk is lost', () => {
    const { unmount, emit, unsubscribe, unsubscribeExit } = mountHook()

    emit('pty-a', 'tail-1 ')
    emit('pty-a', 'tail-2 ')
    // Deliberately do NOT run the frame callback — unmount must drain.
    expect(mockAppendTranscript).not.toHaveBeenCalled()

    unmount()

    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', 'tail-1 tail-2 ')
    // The pending frame callback was cancelled — no rAF leak after unmount.
    expect(cancelledHandles).toHaveLength(1)
    expect(scheduled.size).toBe(0)
    // The subscription was detached — no PTY data flows after unmount.
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(unsubscribeExit).toHaveBeenCalledTimes(1)

    // Nothing further can fire, even if a stray frame callback were invoked.
    runScheduledFrames()
    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
  })

  it('drains unknown-PTY buffers on unmount once the terminal record exists', () => {
    let terminal: TerminalRecord | undefined
    mockFindTerminalByPtyId.mockImplementation(() => terminal)
    const { unmount, emit } = mountHook()

    emit('pty-x', 'pre-store ')
    emit('pty-x', 'chunk ')

    // Terminal record appears but no further chunk arrives — the buffer is
    // still pending when unmount happens.
    terminal = { rendererAttachmentCount: 0, isAppHidden: false }

    unmount()

    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-x', 'pre-store chunk ')
  })

  it('preserves chunk order for data buffered before the store knows the ptyId', () => {
    let terminal: TerminalRecord | undefined
    mockFindTerminalByPtyId.mockImplementation(() => terminal)
    const { emit } = mountHook()

    // Chunks 1-2 arrive while the store has no terminal record.
    emit('pty-x', 'early-1 ')
    emit('pty-x', 'early-2 ')
    expect(mockAppendTranscript).not.toHaveBeenCalled()
    expect(scheduled.size).toBe(0)

    // Record appears; a later chunk triggers the flush of the whole buffer.
    terminal = { rendererAttachmentCount: 0, isAppHidden: false }
    emit('pty-x', 'late-3')

    runScheduledFrames()

    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-x', 'early-1 early-2 late-3')
  })

  it('still flushes detached-captured chunks when a renderer attaches before the frame flush', () => {
    let terminal: TerminalRecord | undefined = { rendererAttachmentCount: 0, isAppHidden: false }
    mockFindTerminalByPtyId.mockImplementation(() => terminal)
    const { emit } = mountHook()

    // Chunks arrive while detached and are buffered for the next frame...
    emit('pty-a', 'buffered-while-detached ')
    emit('pty-a', 'more')
    expect(scheduled.size).toBe(1)

    // ...then a renderer mounts within the same frame, before the flush.
    terminal = { rendererAttachmentCount: 1, isAppHidden: false }

    runScheduledFrames()

    // The chunks arrived while NO renderer existed, so nobody displayed them
    // live — dropping them would lose data the pre-coalescing code captured
    // synchronously. The buffer still flushes into the transcript (it will
    // surface on a future replay rather than the current one).
    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', 'buffered-while-detached more')

    // Post-attach chunks are never captured.
    emit('pty-a', 'post-attach')
    runScheduledFrames()
    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    expect(scheduled.size).toBe(0)
  })

  it('drops pre-store chunks when the terminal turns out to have an attached renderer', () => {
    let ptyATerminal: TerminalRecord | undefined
    let ptyBTerminal: TerminalRecord | undefined
    mockFindTerminalByPtyId.mockImplementation((ptyId: string) =>
      ptyId === 'pty-a' ? ptyATerminal : ptyBTerminal
    )
    const { emit } = mountHook()

    // Chunks arrive while the store has no record; the renderer is attached
    // and writing them into xterm live.
    emit('pty-a', 'pre-store-1 ')
    emit('pty-a', 'pre-store-2')
    expect(mockAppendTranscript).not.toHaveBeenCalled()
    expect(scheduled.size).toBe(0)

    // pty-a's record appears with an attached renderer; pty-b's record exists
    // and is detached. A detached terminal's chunk triggers a flush of the
    // whole map.
    ptyATerminal = { rendererAttachmentCount: 1, isAppHidden: false }
    ptyBTerminal = { rendererAttachmentCount: 0, isAppHidden: false }
    emit('pty-b', 'detached chunk')

    runScheduledFrames()

    // pty-b's detached chunk is appended; pty-a's pre-store buffer (whose
    // renderer displayed it live all along) is dropped, not double-captured.
    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-b', 'detached chunk')
  })

  it('falls back to a timer flush when requestAnimationFrame is unavailable', () => {
    // jsdom-like environment without rAF — the hook must coalesce on a
    // ~16ms timer instead, with identical single-append semantics.
    vi.useFakeTimers()
    const noRaf = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown }
    delete noRaf.requestAnimationFrame
    delete noRaf.cancelAnimationFrame
    try {
      const { unmount, emit } = mountHook()

      emit('pty-a', 'fallback-1 ')
      emit('pty-a', 'fallback-2')
      expect(mockAppendTranscript).not.toHaveBeenCalled()

      vi.advanceTimersByTime(16)

      expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
      expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', 'fallback-1 fallback-2')

      unmount()
    } finally {
      noRaf.requestAnimationFrame = originalRaf
      noRaf.cancelAnimationFrame = originalCancelRaf
      vi.useRealTimers()
    }
  })

  it('flushes via the timer backstop when rAF never fires (hidden webview)', () => {
    // A hidden webview suspends rAF indefinitely; the 250ms timer backstop
    // must still flush so the per-ptyId buffers stay bounded.
    vi.useFakeTimers()
    // Re-stub rAF AFTER useFakeTimers (it would otherwise install a fake
    // that fires at ~16ms): our stub captures the frame callback and never
    // runs it — the exact suspended-frame condition.
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      const handle = nextHandle++
      scheduled.set(handle, cb)
      return handle
    }) as typeof requestAnimationFrame
    try {
      const { unmount, emit } = mountHook()

      emit('pty-a', 'hidden-1 ')
      emit('pty-a', 'hidden-2')
      // No frame callback is run (rAF suspended) — nothing flushed yet.
      expect(scheduled.size).toBe(1)
      expect(mockAppendTranscript).not.toHaveBeenCalled()

      vi.advanceTimersByTime(249)
      expect(mockAppendTranscript).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
      expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', 'hidden-1 hidden-2')

      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the surviving backstop timer after a frame flush (no second early flush)', () => {
    // A frame flush wins the pair; its 250ms backstop loser must be cancelled
    // so it cannot fire a second, early flush of a burst scheduled later.
    vi.useFakeTimers()
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      const handle = nextHandle++
      scheduled.set(handle, cb)
      return handle
    }) as typeof requestAnimationFrame
    try {
      const { unmount, emit } = mountHook()

      emit('pty-a', 'first-burst ')
      expect(scheduled.size).toBe(1)
      runScheduledFrames()
      expect(mockAppendTranscript).toHaveBeenCalledTimes(1)

      // A new burst arrives long after; its own pair is scheduled fresh.
      vi.advanceTimersByTime(200)
      emit('pty-a', 'second-burst')
      expect(scheduled.size).toBe(1)

      // The FIRST pair's backstop would have fired at t=250 and prematurely
      // flushed the second burst — it must have been cancelled at the first
      // flush. Only the second pair's timer remains.
      vi.advanceTimersByTime(50) // t=250: first backstop would fire here
      expect(mockAppendTranscript).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(200) // t=450: second pair's backstop fires
      expect(mockAppendTranscript).toHaveBeenCalledTimes(2)
      expect(mockAppendTranscript).toHaveBeenLastCalledWith('pty-a', 'second-burst')

      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes unknown-PTY data that stays unknown without appending', () => {
    mockFindTerminalByPtyId.mockReturnValue(undefined)
    const { unmount, emit } = mountHook()

    emit('pty-x', 'never-registered')
    // A flush triggered by another terminal must not deliver unknown data.
    mockFindTerminalByPtyId.mockImplementation((ptyId: string) =>
      ptyId === 'pty-known' ? { rendererAttachmentCount: 0, isAppHidden: false } : undefined
    )
    emit('pty-known', 'known chunk')

    runScheduledFrames()

    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-known', 'known chunk')

    unmount()
    // Still no terminal record for pty-x — its data is discarded on unmount,
    // matching the pre-coalescing pendingDetachedBuffer semantics.
    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
  })

  it('buffers register before drain without a new chunk (store subscription retries)', () => {
    // Pre-store chunks arrive; no flush is scheduled (unknown pty).
    mockFindTerminalByPtyId.mockReturnValue(undefined)
    const { unmount, emit } = mountHook()
    emit('pty-x', 'early ')
    emit('pty-x', 'data')
    expect(scheduled.size).toBe(0)

    // The store update that binds the ptyId (setTerminalPtyId) fires the
    // subscription → flushPending retries the retained buffer immediately.
    mockFindTerminalByPtyId.mockReturnValue({ rendererAttachmentCount: 0, isAppHidden: false })
    const storeListener = (
      vi.mocked(useTerminalStore.subscribe) as { mock: { calls: unknown[][] } }
    ).mock.calls[0]?.[0] as (() => void) | undefined
    expect(storeListener).toBeTypeOf('function')
    storeListener?.()

    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-x', 'early data')
    unmount()
  })

  it('clips the buffer at the overflow position, preserving the newest chars', () => {
    mockFindTerminalByPtyId.mockReturnValue({ rendererAttachmentCount: 0, isAppHidden: false })
    const { unmount, emit } = mountHook()

    // A near-cap chunk, then a small one: the buffered stream exceeds
    // MAX_TRANSCRIPT_CHARS by 10k chars — the newest 1.5M chars must be
    // kept (the big chunk's head clipped), not the big chunk dropped whole.
    const cap = 1_500_000
    const big = 'a'.repeat(cap - 10_000)
    const tail = 'b'.repeat(20_000)
    emit('pty-a', big)
    emit('pty-a', tail)
    runScheduledFrames()

    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    const appended = mockAppendTranscript.mock.calls[0]?.[1] as string
    expect(appended.length).toBe(cap)
    // The oldest 10k 'a's were clipped from the head; the tail survived.
    expect(appended.startsWith('a')).toBe(true)
    expect(appended.endsWith('b'.repeat(20_000))).toBe(true)

    // A single oversized chunk is clipped from its head too.
    mockAppendTranscript.mockClear()
    emit('pty-b', 'c'.repeat(cap + 5_000))
    runScheduledFrames()
    const single = mockAppendTranscript.mock.calls[0]?.[1] as string
    expect(single.length).toBe(cap)
    expect(single).toBe('c'.repeat(cap))
    unmount()
  })

  const EURO = [0xe2, 0x82, 0xac]

  it('renders a multi-byte character split across two chunks intact', () => {
    const { unmount, emitBytes } = mountHook()

    emitBytes('pty-a', EURO.slice(0, 1))
    emitBytes('pty-a', EURO.slice(1))
    runScheduledFrames()

    expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', '€')

    unmount()
  })

  it('keeps each terminal on its own decoder when split characters interleave', () => {
    const { unmount, emitBytes, emit } = mountHook()

    emitBytes('pty-a', EURO.slice(0, 2))
    emit('pty-b', 'b')
    emitBytes('pty-a', EURO.slice(2))
    runScheduledFrames()

    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', '€')
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-b', 'b')

    unmount()
  })

  it('flushes a truncated character when the pty exits and starts the next stream clean', () => {
    const { unmount, emitBytes, emit, exit } = mountHook()

    emitBytes('pty-a', EURO.slice(0, 1))
    exit('pty-a')
    runScheduledFrames()
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', '\uFFFD')

    mockAppendTranscript.mockClear()
    emit('pty-a', 'x')
    runScheduledFrames()
    expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', 'x')

    unmount()
  })

  describe('buffers waiting for a terminal record', () => {
    const RECORD = { rendererAttachmentCount: 0, isAppHidden: false }
    const EXIT_GRACE_MS = 5 * 60_000

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      mockFindTerminalByPtyId.mockReturnValue(undefined)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    function registerRecord(): void {
      mockFindTerminalByPtyId.mockReturnValue(RECORD)
      const storeListener = vi.mocked(useTerminalStore.subscribe).mock.calls[0]?.[0] as
        | (() => void)
        | undefined
      storeListener?.()
    }

    it('delivers output to a running pty that restore registers after more than 30s', () => {
      const { unmount, emit } = mountHook()

      emit('pty-restored', 'REPLAYED SCROLLBACK')
      vi.advanceTimersByTime(31_000)
      registerRecord()

      expect(mockAppendTranscript).toHaveBeenCalledWith('pty-restored', 'REPLAYED SCROLLBACK')
      expect(mockLogFrontendError).not.toHaveBeenCalled()
      unmount()
    })

    it('delivers a preserved reattach replay whose snapshot exit lands before registration', () => {
      const { unmount, emit, exit } = mountHook()

      emit('pty-preserved', 'REPLAYED SCROLLBACK')
      exit('pty-preserved')
      vi.advanceTimersByTime(60_000)
      registerRecord()

      expect(mockAppendTranscript).toHaveBeenCalledWith('pty-preserved', 'REPLAYED SCROLLBACK')
      unmount()
    })

    it('delivers agent-launch output that exits before its record is bound 31s later', () => {
      const { unmount, emit, exit } = mountHook()

      emit('pty-agent', 'agent: command not found\r\n')
      exit('pty-agent')
      emit('pty-agent', 'late final batch')
      vi.advanceTimersByTime(31_000)
      registerRecord()

      expect(mockAppendTranscript).toHaveBeenCalledWith(
        'pty-agent',
        'agent: command not found\r\nlate final batch'
      )
      unmount()
    })

    it('keeps a streaming pty that never registers without ever warning', () => {
      const { unmount, emit } = mountHook()

      for (let minute = 0; minute < 20; minute++) {
        emit('pty-unregistered', `m${minute} `)
        vi.advanceTimersByTime(60_000)
      }
      expect(mockLogFrontendError).not.toHaveBeenCalled()

      registerRecord()
      expect(mockAppendTranscript).toHaveBeenCalledTimes(1)
      expect(mockAppendTranscript.mock.calls[0][1]).toMatch(/^m0 m1 .* m19 $/)
      unmount()
    })

    it('drops an exited pty buffer silently once the grace passes with no record', () => {
      const { unmount, emit, exit } = mountHook()

      emit('pty-orphan', 'orphaned output')
      exit('pty-orphan')
      vi.advanceTimersByTime(EXIT_GRACE_MS)
      registerRecord()

      expect(mockAppendTranscript).not.toHaveBeenCalled()
      expect(mockLogFrontendError).not.toHaveBeenCalled()
      unmount()
    })

    it('drops the final output of a closed terminal without a warning', () => {
      mockFindTerminalByPtyId.mockReturnValue(RECORD)
      const { unmount, emit, exit } = mountHook()

      exit('pty-closed')
      mockFindTerminalByPtyId.mockReturnValue(undefined)
      emit('pty-closed', 'logout\r\n')
      vi.advanceTimersByTime(EXIT_GRACE_MS)
      registerRecord()

      expect(mockAppendTranscript).not.toHaveBeenCalled()
      expect(mockLogFrontendError).not.toHaveBeenCalled()
      unmount()
    })

    it('decodes each chunk that arrives after exit on its own', () => {
      mockFindTerminalByPtyId.mockReturnValue(RECORD)
      const { unmount, emitBytes, exit } = mountHook()

      exit('pty-a')
      emitBytes('pty-a', [...EURO, 0x21])
      emitBytes('pty-a', EURO.slice(0, 1))
      emitBytes('pty-a', EURO.slice(1))
      runScheduledFrames()

      expect(mockAppendTranscript).toHaveBeenCalledWith('pty-a', '€!\uFFFD\uFFFD\uFFFD')
      unmount()
    })
  })
})
