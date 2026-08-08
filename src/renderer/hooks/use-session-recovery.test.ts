import type { Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRegistry, registerTerminal } from '@/utils/terminal-registry'
import { toTerminalSession } from './use-session-recovery'

/**
 * Mock xterm terminal exposing the public `parser.registerCsiHandler` API so
 * the mode tracker (registered via registerTerminal) can capture DEC modes.
 */
function createMockParserTerminal(id: string): Terminal {
  const handlers: Array<{
    prefix: string | undefined
    final: string
    cb: (params: (number | number[])[]) => boolean
    disposed: boolean
  }> = []
  const terminal = {
    parser: {
      registerCsiHandler: (
        idf: { prefix?: string; intermediates?: string; final: string },
        cb: (params: (number | number[])[]) => boolean
      ) => {
        const entry = { prefix: idf.prefix, final: idf.final, cb, disposed: false }
        handlers.push(entry)
        return {
          dispose: () => {
            entry.disposed = true
          }
        }
      }
    },
    write: vi.fn()
  } as unknown as Terminal
  // Expose an invoke helper on the mock for the test to drive the set handler.
  ;(terminal as unknown as Record<string, unknown>).__invokeCsi = (
    prefix: string | undefined,
    final: string,
    params: (number | number[])[]
  ) => {
    for (const h of handlers.filter((h) => !h.disposed)) {
      if (h.prefix === prefix && h.final === final) h.cb(params)
    }
  }
  void id
  return terminal
}

describe('toTerminalSession — R3 mode capture at save time', () => {
  beforeEach(() => {
    clearRegistry()
  })

  it('captures the live tracked DEC modes keyed by ptyId', () => {
    const ptyId = 'pty-vim'
    const terminal = createMockParserTerminal(ptyId)
    registerTerminal(ptyId, terminal)
    // Drive the captured set handler: enter alt-screen + bracketed paste.
    const invoke = (
      terminal as unknown as {
        __invokeCsi: (p: string | undefined, f: string, params: (number | number[])[]) => void
      }
    ).__invokeCsi
    invoke('?', 'h', [1049])
    invoke('?', 'h', [2004])

    const session = toTerminalSession({
      id: 'store-1',
      ptyId,
      name: 'Terminal 1',
      projectId: 'proj-1',
      shell: 'bash',
      cwd: '/repo'
    } as Parameters<typeof toTerminalSession>[0])

    expect(session.modes).toEqual(
      expect.objectContaining({ alternateScreen: true, bracketedPaste: true })
    )
    // history still derived from pendingScrollback/transcript.
    expect(session.history).toEqual([])
    expect(session.id).toBe('store-1')
  })

  it('falls back to ptyId ?? id when ptyId is absent', () => {
    const id = 'id-only'
    const terminal = createMockParserTerminal(id)
    registerTerminal(id, terminal)
    const invoke = (
      terminal as unknown as {
        __invokeCsi: (p: string | undefined, f: string, params: (number | number[])[]) => void
      }
    ).__invokeCsi
    invoke('?', 'h', [1]) // application-cursor

    const session = toTerminalSession({
      id,
      name: 'Terminal 1',
      projectId: 'proj-1',
      shell: 'bash',
      cwd: '/repo'
    } as Parameters<typeof toTerminalSession>[0])

    expect(session.modes?.applicationCursor).toBe(true)
  })

  it('degrades to no modes when no tracker is registered (best-effort)', () => {
    const session = toTerminalSession({
      id: 'ghost',
      ptyId: 'pty-ghost',
      name: 'Terminal 1',
      projectId: 'proj-1',
      shell: 'bash',
      cwd: '/repo',
      pendingScrollback: ['$ ls', 'out.txt']
    } as Parameters<typeof toTerminalSession>[0])
    expect(session.modes).toBeUndefined()
    expect(session.history).toEqual(['$ ls', 'out.txt'])
  })
})
