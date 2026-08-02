import type { Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalModes } from '../../shared/types/ipc.types'
import {
  buildRehydrateSequences,
  clearRegistry,
  destroyTerminal,
  getTerminalModes,
  registerTerminal,
  restoreScrollback,
  startTrackingModes,
  stopTrackingModes,
  unregisterTerminal
} from './terminal-registry'

/**
 * Mock xterm terminal exposing the PUBLIC `parser.registerCsiHandler` API so
 * the tracker can be exercised. `invokeCsi` dispatches a CSI to the active
 * (non-disposed) handlers for a given prefix+final, mirroring xterm's dispatch.
 */
function createMockParserTerminal(): {
  terminal: Terminal
  invokeCsi: (prefix: string | undefined, final: string, params: (number | number[])[]) => void
  activeCount: () => number
} {
  interface Handler {
    prefix: string | undefined
    final: string
    cb: (params: (number | number[])[]) => boolean
    disposed: boolean
  }
  const handlers: Handler[] = []
  const active = (): Handler[] => handlers.filter((h) => !h.disposed)
  const terminal = {
    parser: {
      registerCsiHandler: vi.fn(
        (
          id: { prefix?: string; intermediates?: string; final: string },
          cb: (params: (number | number[])[]) => boolean
        ) => {
          const entry: Handler = { prefix: id.prefix, final: id.final, cb, disposed: false }
          handlers.push(entry)
          return {
            dispose: () => {
              entry.disposed = true
            }
          }
        }
      )
    },
    write: vi.fn()
  } as unknown as Terminal
  const invokeCsi = (
    prefix: string | undefined,
    final: string,
    params: (number | number[])[]
  ): void => {
    for (const h of active()) {
      if (h.prefix === prefix && h.final === final) h.cb(params)
    }
  }
  return { terminal, invokeCsi, activeCount: () => active().length }
}

describe('terminal-mode-tracker — DEC private mode capture', () => {
  beforeEach(() => {
    clearRegistry()
  })

  it('no-ops gracefully for a terminal without a parser surface', () => {
    const terminal = { write: vi.fn() } as unknown as Terminal
    startTrackingModes('no-parser', terminal)
    expect(getTerminalModes('no-parser')).toBeUndefined()
    registerTerminal('no-parser', terminal)
    expect(getTerminalModes('no-parser')).toBeUndefined()
  })

  it('captures alt-screen / bracketed-paste / application-cursor on CSI ?...h', () => {
    const { terminal, invokeCsi } = createMockParserTerminal()
    registerTerminal('vim', terminal)

    invokeCsi('?', 'h', [1049])
    invokeCsi('?', 'h', [2004])
    invokeCsi('?', 'h', [1])

    expect(getTerminalModes('vim')).toEqual(
      expect.objectContaining({
        alternateScreen: true,
        bracketedPaste: true,
        applicationCursor: true,
        mouseTracking: null,
        sgrMouseMode: false,
        sgrMousePixelsMode: false
      })
    )
  })

  it('treats 1047 and 47 as alt-screen too (replays 1049)', () => {
    const { terminal, invokeCsi } = createMockParserTerminal()
    startTrackingModes('legacy-alt', terminal)
    invokeCsi('?', 'h', [1047])
    expect(getTerminalModes('legacy-alt')?.alternateScreen).toBe(true)
  })

  it('captures mouse tracking modes as the x10/drag/any enum', () => {
    const { terminal, invokeCsi } = createMockParserTerminal()
    startTrackingModes('tmux', terminal)

    invokeCsi('?', 'h', [1002]) // drag
    expect(getTerminalModes('tmux')?.mouseTracking).toBe('drag')

    invokeCsi('?', 'h', [1003]) // any supersedes
    expect(getTerminalModes('tmux')?.mouseTracking).toBe('any')

    invokeCsi('?', 'h', [1000]) // x10 supersedes
    expect(getTerminalModes('tmux')?.mouseTracking).toBe('x10')
  })

  it('captures SGR mouse modes (1006 / 1016)', () => {
    const { terminal, invokeCsi } = createMockParserTerminal()
    startTrackingModes('sgr', terminal)
    invokeCsi('?', 'h', [1006])
    invokeCsi('?', 'h', [1016])
    const modes = getTerminalModes('sgr')
    expect(modes?.sgrMouseMode).toBe(true)
    expect(modes?.sgrMousePixelsMode).toBe(true)
  })

  it('resets modes on CSI ?...l', () => {
    const { terminal, invokeCsi } = createMockParserTerminal()
    startTrackingModes('reset', terminal)
    invokeCsi('?', 'h', [1049, 2004, 1, 1006]) // multiple modes in one sequence
    invokeCsi('?', 'l', [1049])
    invokeCsi('?', 'l', [2004])
    invokeCsi('?', 'l', [1])
    invokeCsi('?', 'l', [1006])

    const modes = getTerminalModes('reset')
    expect(modes?.alternateScreen).toBe(false)
    expect(modes?.bracketedPaste).toBe(false)
    expect(modes?.applicationCursor).toBe(false)
    expect(modes?.sgrMouseMode).toBe(false)
  })

  it('reset of a mouse mode clears only the matching enum value', () => {
    const { terminal, invokeCsi } = createMockParserTerminal()
    startTrackingModes('mouse-reset', terminal)
    invokeCsi('?', 'h', [1002]) // drag
    invokeCsi('?', 'l', [1000]) // x10 reset — 1000 was not active, no change
    expect(getTerminalModes('mouse-reset')?.mouseTracking).toBe('drag')
    invokeCsi('?', 'l', [1002]) // matching reset clears
    expect(getTerminalModes('mouse-reset')?.mouseTracking).toBe(null)
  })

  it('tracker handlers return false (passive observer) so xterm still applies the mode', () => {
    const { terminal } = createMockParserTerminal()
    startTrackingModes('passive', terminal)
    const calls = (
      terminal as unknown as {
        parser: { registerCsiHandler: ReturnType<typeof vi.fn> }
      }
    ).parser.registerCsiHandler.mock.calls as [
      { prefix?: string; final: string },
      (p: (number | number[])[]) => boolean
    ][]
    const setCb = calls.find((c) => c[0].prefix === '?' && c[0].final === 'h')?.[1]
    const resetCb = calls.find((c) => c[0].prefix === '?' && c[0].final === 'l')?.[1]
    expect(setCb).toBeDefined()
    expect(resetCb).toBeDefined()

    // Set handler is passive (returns false → xterm's built-in handler still
    // runs) but still records the mode for persistence.
    expect(setCb!([1049])).toBe(false)
    expect(getTerminalModes('passive')?.alternateScreen).toBe(true)

    // Reset handler is passive and clears the recorded mode.
    expect(resetCb!([1049])).toBe(false)
    expect(getTerminalModes('passive')?.alternateScreen).toBe(false)
  })

  it('registers handlers with prefix ? (not intermediates) for final h and l', () => {
    const { terminal } = createMockParserTerminal()
    startTrackingModes('prefix', terminal)
    const calls = (
      terminal as unknown as {
        parser: { registerCsiHandler: ReturnType<typeof vi.fn> }
      }
    ).parser.registerCsiHandler.mock.calls as [
      { prefix?: string; intermediates?: string; final: string },
      (p: (number | number[])[]) => boolean
    ][]
    const finals = calls.map((c) => ({ prefix: c[0].prefix, final: c[0].final }))
    expect(finals).toContainEqual({ prefix: '?', final: 'h' })
    expect(finals).toContainEqual({ prefix: '?', final: 'l' })
    expect(calls.every((c) => c[0].intermediates === undefined)).toBe(true)
  })

  it('startTracking is idempotent (re-start disposes prior handlers)', () => {
    const { terminal, activeCount } = createMockParserTerminal()
    startTrackingModes('reuse', terminal)
    expect(activeCount()).toBe(2)
    startTrackingModes('reuse', terminal) // re-register
    expect(activeCount()).toBe(2) // old disposed, new active
  })

  it('stopTracking disposes handlers and clears the snapshot', () => {
    const { terminal, activeCount } = createMockParserTerminal()
    startTrackingModes('stop', terminal)
    expect(activeCount()).toBe(2)
    stopTrackingModes('stop')
    expect(activeCount()).toBe(0)
    expect(getTerminalModes('stop')).toBeUndefined()
  })

  it('registerTerminal/unregisterTerminal/destroyTerminal wire the tracker lifecycle', () => {
    const { terminal, activeCount } = createMockParserTerminal()
    registerTerminal('lifecycle', terminal)
    expect(activeCount()).toBe(2)
    expect(getTerminalModes('lifecycle')).toBeDefined()

    unregisterTerminal('lifecycle')
    expect(activeCount()).toBe(0)
    expect(getTerminalModes('lifecycle')).toBeUndefined()

    registerTerminal('destroy', terminal)
    destroyTerminal('destroy')
    expect(activeCount()).toBe(0)
    expect(getTerminalModes('destroy')).toBeUndefined()
  })

  it('clearRegistry disposes all trackers', () => {
    const a = createMockParserTerminal()
    const b = createMockParserTerminal()
    registerTerminal('a', a.terminal)
    registerTerminal('b', b.terminal)
    expect(a.activeCount() + b.activeCount()).toBe(4)
    clearRegistry()
    expect(a.activeCount() + b.activeCount()).toBe(0)
    expect(getTerminalModes('a')).toBeUndefined()
    expect(getTerminalModes('b')).toBeUndefined()
  })
})

describe('buildRehydrateSequences — Orca DEC-sequence table', () => {
  it('returns empty for no/empty modes (normal shell)', () => {
    expect(buildRehydrateSequences(undefined)).toBe('')
    expect(buildRehydrateSequences(null)).toBe('')
    expect(
      buildRehydrateSequences({
        alternateScreen: false,
        bracketedPaste: false,
        applicationCursor: false,
        mouseTracking: null,
        sgrMouseMode: false,
        sgrMousePixelsMode: false
      })
    ).toBe('')
  })

  it('emits each mode on, in the Orca order', () => {
    const base: TerminalModes = {
      alternateScreen: false,
      bracketedPaste: false,
      applicationCursor: false,
      mouseTracking: null,
      sgrMouseMode: false,
      sgrMousePixelsMode: false
    }
    expect(buildRehydrateSequences({ ...base, alternateScreen: true })).toBe('\x1b[0m\x1b[?1049h')
    expect(buildRehydrateSequences({ ...base, bracketedPaste: true })).toBe('\x1b[?2004h')
    expect(buildRehydrateSequences({ ...base, applicationCursor: true })).toBe('\x1b[?1h')
    expect(buildRehydrateSequences({ ...base, mouseTracking: 'x10' })).toBe('\x1b[?1000h')
    expect(buildRehydrateSequences({ ...base, mouseTracking: 'drag' })).toBe('\x1b[?1002h')
    expect(buildRehydrateSequences({ ...base, mouseTracking: 'any' })).toBe('\x1b[?1003h')
    expect(buildRehydrateSequences({ ...base, sgrMouseMode: true })).toBe('\x1b[?1006h')
    expect(buildRehydrateSequences({ ...base, sgrMousePixelsMode: true })).toBe('\x1b[?1016h')
  })

  it('vim combo: alt-screen + bracketed-paste + application-cursor', () => {
    expect(
      buildRehydrateSequences({
        alternateScreen: true,
        bracketedPaste: true,
        applicationCursor: true,
        mouseTracking: null,
        sgrMouseMode: false,
        sgrMousePixelsMode: false
      })
    ).toBe('\x1b[0m\x1b[?1049h\x1b[?2004h\x1b[?1h')
  })

  it('tmux combo: mouse drag + SGR mouse', () => {
    expect(
      buildRehydrateSequences({
        alternateScreen: false,
        bracketedPaste: false,
        applicationCursor: false,
        mouseTracking: 'drag',
        sgrMouseMode: true,
        sgrMousePixelsMode: false
      })
    ).toBe('\x1b[?1002h\x1b[?1006h')
  })
})

describe('restoreScrollback — R3 mode replay before content (I/O matrix)', () => {
  function makeTerminal(): { terminal: Terminal; write: ReturnType<typeof vi.fn> } {
    const write = vi.fn()
    return { terminal: { write } as unknown as Terminal, write }
  }

  it('vim row: emits DEC modes before the captured alt-screen content', () => {
    const { terminal, write } = makeTerminal()
    const modes: TerminalModes = {
      alternateScreen: true,
      bracketedPaste: true,
      applicationCursor: true,
      mouseTracking: null,
      sgrMouseMode: false,
      sgrMousePixelsMode: false
    }
    restoreScrollback(terminal, ['~ editing in vim', '~ line 2'], modes)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(
      '\x1b[0m\x1b[?1049h\x1b[?2004h\x1b[?1h~ editing in vim\r\n~ line 2\r\n'
    )
  })

  it('tmux row: emits mouse + SGR before content', () => {
    const { terminal, write } = makeTerminal()
    restoreScrollback(terminal, ['[0] 0:bash*'], {
      alternateScreen: false,
      bracketedPaste: false,
      applicationCursor: false,
      mouseTracking: 'drag',
      sgrMouseMode: true,
      sgrMousePixelsMode: false
    })
    expect(write).toHaveBeenCalledWith('\x1b[?1002h\x1b[?1006h[0] 0:bash*\r\n')
  })

  it('normal-shell row: no modes → content only (no regression to pre-R3)', () => {
    const { terminal, write } = makeTerminal()
    restoreScrollback(terminal, ['$ ls', 'file.txt'], undefined)
    expect(write).toHaveBeenCalledWith('$ ls\r\nfile.txt\r\n')
  })

  it('no-saved-modes row: degrades to content-only, no throw', () => {
    const { terminal, write } = makeTerminal()
    expect(() => restoreScrollback(terminal, ['content'], undefined)).not.toThrow()
    expect(write).toHaveBeenCalledWith('content\r\n')
  })

  it('preserves ANSI sequences in content alongside modes', () => {
    const { terminal, write } = makeTerminal()
    restoreScrollback(terminal, ['\u001b[32mgreen\u001b[0m'], {
      alternateScreen: true,
      bracketedPaste: false,
      applicationCursor: false,
      mouseTracking: null,
      sgrMouseMode: false,
      sgrMousePixelsMode: false
    })
    expect(write).toHaveBeenCalledWith('\u001b[0m\u001b[?1049h\u001b[32mgreen\u001b[0m\r\n')
  })

  it('no content → no write, even with modes (empty terminal)', () => {
    const { terminal, write } = makeTerminal()
    restoreScrollback(terminal, [], {
      alternateScreen: true,
      bracketedPaste: true,
      applicationCursor: false,
      mouseTracking: null,
      sgrMouseMode: false,
      sgrMousePixelsMode: false
    })
    expect(write).not.toHaveBeenCalled()
  })
})
