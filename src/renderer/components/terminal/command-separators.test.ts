import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachCommandSeparators } from './command-separators'

function stubCanvasContext(): void {
  const context = new Proxy(
    { measureText: () => ({ width: 8 }) },
    {
      get: (target, prop) =>
        prop in target ? (target as Record<string | symbol, unknown>)[prop] : () => undefined,
      set: () => true
    }
  )
  HTMLCanvasElement.prototype.getContext = (() =>
    context) as unknown as HTMLCanvasElement['getContext']
}

function createTerminal(options: { cols?: number; rows?: number; scrollback?: number } = {}): {
  terminal: Terminal
  container: HTMLDivElement
  write: (data: string) => Promise<void>
} {
  stubCanvasContext()
  const container = document.createElement('div')
  container.style.width = '800px'
  container.style.height = '600px'
  document.body.appendChild(container)

  const terminal = new Terminal({
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    scrollback: options.scrollback ?? 1000,
    allowProposedApi: true
  })
  terminal.open(container)

  const write = (data: string): Promise<void> =>
    new Promise((resolve) => {
      terminal.write(data, resolve)
    })

  return { terminal, container, write }
}

describe('command-separators', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  let createdContainers: HTMLDivElement[] = []
  let createdTerminals: Terminal[] = []

  function setupTerminal(options: { cols?: number; rows?: number; scrollback?: number } = {}) {
    const fixture = createTerminal(options)
    createdContainers.push(fixture.container)
    createdTerminals.push(fixture.terminal)
    return fixture
  }

  afterEach(() => {
    for (const t of createdTerminals) {
      t.dispose()
    }
    for (const c of createdContainers) {
      c.remove()
    }
    createdTerminals = []
    createdContainers = []
    HTMLCanvasElement.prototype.getContext = originalGetContext
    vi.restoreAllMocks()
  })

  it('places a marker and decoration at the row of the command after out\\r\\n\\r\\n + 133;A;termul + \\r\\ncmd', async () => {
    const { terminal, write } = setupTerminal()
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    await write('out\r\n\r\n\x1b]133;A;termul\x07\r\ncmd\r\n')

    expect(decSpy).toHaveBeenCalledTimes(1)
    const callArg = decSpy.mock.calls[0][0]
    expect(callArg.marker).toBeDefined()
    expect(callArg.marker.line).toBe(2)
    expect(callArg.width).toBe(terminal.cols)
  })

  it('handles an OSC split across two writes', async () => {
    const { terminal, write } = setupTerminal()
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    await write('out\r\n\r\n')
    await write('\x1b]133;')
    await write('A;termul\x07\r\ncmd\r\n')

    expect(decSpy).toHaveBeenCalledTimes(1)
    expect(decSpy.mock.calls[0][0].marker.line).toBe(2)
  })

  it('anchors on the next row under pending wrap when cursorX >= cols', async () => {
    const { terminal, write } = setupTerminal({ cols: 10 })
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    // Row 0 has content, followed by CRLF
    await write('content\r\n')
    // Row 1 is a whitespace-only row exactly cols wide (pending wrap set)
    await write(' '.repeat(10))
    expect(terminal.buffer.active.cursorX).toBe(10)

    // Emit private mark with no CRLF
    await write('\x1b]133;A;termul\x07x')

    expect(decSpy).toHaveBeenCalledTimes(1)
    const marker = decSpy.mock.calls[0][0].marker
    expect(marker.line).toBe(2)
  })

  it('draws no line for the first prompt on an empty screen, but draws one after banner output', async () => {
    // Empty screen: first prompt
    const term1 = setupTerminal()
    const spy1 = vi.spyOn(term1.terminal, 'registerDecoration')
    attachCommandSeparators(term1.terminal)

    await term1.write('\x1b]133;A;termul\x07prompt$ ')
    expect(spy1).not.toHaveBeenCalled()

    // Banner output: non-whitespace row above
    const term2 = setupTerminal()
    const spy2 = vi.spyOn(term2.terminal, 'registerDecoration')
    attachCommandSeparators(term2.terminal)

    await term2.write('Last login: Mon Oct 26 on ttys001\r\n\r\n\x1b]133;A;termul\x07\r\nprompt$ ')
    expect(spy2).toHaveBeenCalledTimes(1)
    expect(spy2.mock.calls[0][0].marker.line).toBe(2)
  })

  it('draws no line after clear with CSI 3J (clear + scrollback wiped) or reset', async () => {
    const { terminal, write } = setupTerminal({ rows: 5 })
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    for (let i = 0; i < 6; i++) {
      await write(`line ${i}\r\n`)
    }
    await write('\r\n\x1b]133;A;termul\x07\r\ncmd1\r\n')
    expect(decSpy).toHaveBeenCalledTimes(1)

    // Clear screen and scrollback (CSI 3J)
    await write('\x1b[H\x1b[2J\x1b[3J')
    await write('\x1b]133;A;termul\x07cmd2\r\n')
    // No new decoration since anchor is at top and buffer above is empty
    expect(decSpy).toHaveBeenCalledTimes(1)

    // Next command after some output still gets a line
    await write('out2\r\n\r\n\x1b]133;A;termul\x07\r\ncmd3\r\n')
    expect(decSpy).toHaveBeenCalledTimes(2)

    // Reset wipes state
    terminal.reset()
    await write('\x1b]133;A;termul\x07cmd4\r\n')
    expect(decSpy).toHaveBeenCalledTimes(2)
  })

  it('draws no line after clear WITHOUT CSI 3J because the row directly above anchor is not blank', async () => {
    const { terminal, write } = setupTerminal({ rows: 5 })
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    for (let i = 0; i < 6; i++) {
      await write(`line ${i}\r\n`)
    }
    await write('\r\n\x1b]133;A;termul\x07\r\ncmd1\r\n')
    expect(decSpy).toHaveBeenCalledTimes(1)

    // Clear screen only without 3J (ED 2 only; scrollback retained)
    // After clear, host injects nothing; anchor at top has non-blank row in scrollback above, so no line
    await write('\x1b[H\x1b[2J')
    await write('\x1b]133;A;termul\x07cmd2\r\n')
    expect(decSpy).toHaveBeenCalledTimes(1)
  })

  it('disposes markers on scrollback trimming and dedupe ignores disposed markers', async () => {
    const { terminal, write } = setupTerminal({ rows: 5, scrollback: 5 })
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    await write('out\r\n\r\n\x1b]133;A;termul\x07\r\ncmd1\r\n')
    expect(decSpy).toHaveBeenCalledTimes(1)
    const firstMarker = decSpy.mock.calls[0][0].marker

    // Write enough lines to trim the scrollback and dispose firstMarker
    for (let i = 0; i < 20; i++) {
      await write(`line ${i}\r\n`)
    }

    expect(firstMarker.isDisposed).toBe(true)

    // New prompt and command should not throw and should register a new decoration
    await write('\r\n\x1b]133;A;termul\x07\r\ncmd2\r\n')
    expect(decSpy).toHaveBeenCalledTimes(2)
  })

  it('keeps decorations without throw during resize', async () => {
    const { terminal, write } = setupTerminal({ cols: 80, rows: 24 })
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    await write('out\r\n\r\n\x1b]133;A;termul\x07\r\ncmd1\r\n')
    expect(decSpy).toHaveBeenCalledTimes(1)
    const marker = decSpy.mock.calls[0][0].marker

    terminal.resize(100, 30)
    expect(marker.isDisposed).toBe(false)
    expect(marker.line).toBeGreaterThanOrEqual(0)
  })

  it('ignores marks when alternate screen is active', async () => {
    const { terminal, write } = setupTerminal()
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    await write('out\r\n')
    // Enter alternate screen
    await write('\x1b[?1049h')
    expect(terminal.buffer.active.type).toBe('alternate')

    await write('\r\n\x1b]133;A;termul\x07alt-cmd\r\n')
    expect(decSpy).not.toHaveBeenCalled()

    // Exit alternate screen
    await write('\x1b[?1049l')
    expect(terminal.buffer.active.type).toBe('normal')

    await write('\r\n\x1b]133;A;termul\x07\r\nnormal-cmd\r\n')
    expect(decSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores other OSC 133 sequences like 133;B and 133;D;0', async () => {
    const { terminal, write } = setupTerminal()
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    await write('out\r\n\r\n')
    await write('\x1b]133;B\x07')
    await write('\x1b]133;D;0\x07')
    await write('\x1b]133;C\x07')
    await write('\x1b]133;A\x07')
    await write('\x1b]133;A;other\x07')
    expect(decSpy).not.toHaveBeenCalled()
  })

  it('is idempotent: attaching twice does not duplicate handlers or decorations', async () => {
    const { terminal, write } = setupTerminal()
    const oscSpy = vi.spyOn(terminal.parser, 'registerOscHandler')
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)
    attachCommandSeparators(terminal)

    const osc133Calls = oscSpy.mock.calls.filter(([ident]) => ident === 133)
    expect(osc133Calls).toHaveLength(1)
    expect(oscSpy).toHaveBeenCalledTimes(1)

    await write('out\r\n\r\n\x1b]133;A;termul\x07\r\ncmd\r\n')
    expect(decSpy).toHaveBeenCalledTimes(1)
  })

  it('draws no line when anchor is on row > 0 and all earlier rows are empty or whitespace-only', async () => {
    const { terminal, write } = setupTerminal()
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    await write('\r\n\r\n   \r\n\x1b]133;A;termul\x07cmd\r\n')
    expect(decSpy).not.toHaveBeenCalled()
  })

  it('draws a line when a banner is followed by several blank rows and then the mark', async () => {
    const { terminal, write } = setupTerminal()
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    await write('banner\r\n\r\n   \r\n\x1b]133;A;termul\x07cmd\r\n')
    expect(decSpy).toHaveBeenCalledTimes(1)
    expect(decSpy.mock.calls[0][0].marker.line).toBe(3)
  })

  it('always returns false from the OSC 133 handler so observer receives placed marks, skipped marks, and non-A identifiers', async () => {
    const { terminal, write } = setupTerminal()
    let downstreamHandlerCalled = false
    const receivedOscData: string[] = []

    terminal.parser.registerOscHandler(133, (data) => {
      downstreamHandlerCalled = true
      receivedOscData.push(data)
      return false
    })

    attachCommandSeparators(terminal)

    // 1. Placed mark: banner followed by mark
    await write('out\r\n\r\n\x1b]133;A;termul\x07\r\ncmd\r\n')
    expect(downstreamHandlerCalled).toBe(true)
    expect(receivedOscData).toEqual(['A;termul'])

    // 2. Skipped mark: alternate screen
    await write('\x1b[?1049h')
    await write('\x1b]133;A;termul\x07alt-cmd\r\n')
    expect(receivedOscData).toEqual(['A;termul', 'A;termul'])
    await write('\x1b[?1049l')

    // 3. Skipped mark: no text above (after clear screen & scrollback)
    await write('\x1b[H\x1b[2J\x1b[3J')
    await write('\x1b]133;A;termul\x07empty-screen-cmd\r\n')
    expect(receivedOscData).toEqual(['A;termul', 'A;termul', 'A;termul'])

    // 4. Skipped mark: dedupe (another mark at the same row)
    await write('some output\r\n\r\n\x1b]133;A;termul\x07\r\ndedupe-target\r\n')
    expect(receivedOscData).toEqual(['A;termul', 'A;termul', 'A;termul', 'A;termul'])
    // Move cursor up 2 rows back to dedupe-target's row
    await write('\x1b[2A')
    await write('\x1b]133;A;termul\x07dedupe-skip\r\n')
    expect(receivedOscData).toEqual(['A;termul', 'A;termul', 'A;termul', 'A;termul', 'A;termul'])

    // 5. Ignored identifier: 133;B
    await write('\x1b]133;B\x07')
    expect(receivedOscData).toEqual([
      'A;termul',
      'A;termul',
      'A;termul',
      'A;termul',
      'A;termul',
      'B'
    ])
  })

  it('prunes disposed markers so their line getter is not read on subsequent marks', () => {
    let oscHandler: ((data: string) => boolean) | undefined
    let fakeMarker1Disposed = false
    let fakeMarker1LineReads = 0

    const fakeMarker1 = {
      get isDisposed() {
        return fakeMarker1Disposed
      },
      get line() {
        fakeMarker1LineReads++
        return 2
      },
      dispose() {
        fakeMarker1Disposed = true
      }
    }

    let markerIndex = 0
    const fakeTerminal = {
      cols: 80,
      buffer: {
        active: {
          type: 'normal',
          cursorX: 0,
          cursorY: 2,
          baseY: 0,
          getLine: (row: number) => {
            if (row === 0) {
              return { translateToString: () => 'banner text' }
            }
            return { translateToString: () => '' }
          }
        }
      },
      parser: {
        registerOscHandler: (ident: number, handler: (data: string) => boolean) => {
          if (ident === 133) {
            oscHandler = handler
          }
          return { dispose: () => {} }
        }
      },
      registerMarker: vi.fn(() => {
        markerIndex++
        if (markerIndex === 1) {
          return fakeMarker1
        }
        return {
          isDisposed: false,
          line: 3,
          dispose: () => {}
        }
      }),
      registerDecoration: vi.fn(() => ({
        onRender: vi.fn(),
        dispose: vi.fn()
      }))
    }

    attachCommandSeparators(fakeTerminal as unknown as Terminal)
    expect(oscHandler).toBeDefined()

    // 1. First mark: registers fakeMarker1
    oscHandler!('A;termul')
    expect(fakeTerminal.registerMarker).toHaveBeenCalledTimes(1)
    expect(fakeMarker1LineReads).toBe(0)

    // 2. Mark the marker disposed and move cursor to row 3
    fakeMarker1.dispose()
    fakeTerminal.buffer.active.cursorY = 3

    // 3. Second mark: pruning drops fakeMarker1 without reading its line getter
    oscHandler!('A;termul')
    expect(fakeTerminal.registerMarker).toHaveBeenCalledTimes(2)
    expect(fakeMarker1LineReads).toBe(0)

    // 4. Third mark: fakeMarker1 was dropped from module array, so it is never accessed
    fakeTerminal.buffer.active.cursorY = 4
    oscHandler!('A;termul')
    expect(fakeTerminal.registerMarker).toHaveBeenCalledTimes(3)
    expect(fakeMarker1LineReads).toBe(0)
  })

  it("R2'' dedupe: skips the mark if any live separator marker already sits on the anchor row", async () => {
    const { terminal, write } = setupTerminal()
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    await write('out1\r\n\r\n\x1b]133;A;termul\x07\r\ncmd1\r\n') // marker at line 2
    await write('out2\r\n\r\n\x1b]133;A;termul\x07\r\ncmd2\r\n') // marker at line 5
    expect(decSpy).toHaveBeenCalledTimes(2)

    // Move cursor back to row 2 (1-based: row 3 in ANSI CUP is line 2 in buffer)
    await write('\x1b[3;1H')
    expect(terminal.buffer.active.baseY + terminal.buffer.active.cursorY).toBe(2)

    // New mark arriving at row 2
    await write('\x1b]133;A;termul\x07prompt\r\n')
    expect(decSpy).toHaveBeenCalledTimes(2)
  })

  it('R4: writing transcript with 2 marks yields 2 separators; cached delta yields no duplicates', async () => {
    const { terminal, write } = setupTerminal()
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    const transcript =
      'banner\r\n\r\n\x1b]133;A;termul\x07\r\ncmd1\r\nout1\r\n\r\n\x1b]133;A;termul\x07\r\ncmd2\r\nout2\r\n'
    await write(transcript)
    expect(decSpy).toHaveBeenCalledTimes(2)

    // Replay or delta containing mark on already decorated line
    await write('\x1b[3;1H\x1b]133;A;termul\x07')
    expect(decSpy).toHaveBeenCalledTimes(2)
  })

  it("R4' limitation: in alternate screen, replayed transcript produces no separators and does not throw", async () => {
    const { terminal, write } = setupTerminal()
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    // Switch to alt screen first (e.g. during mode restore)
    await write('\x1b[?1049h')
    const transcript =
      'banner\r\n\r\n\x1b]133;A;termul\x07\r\ncmd1\r\nout1\r\n\r\n\x1b]133;A;termul\x07\r\ncmd2\r\nout2\r\n'

    await expect(write(transcript)).resolves.not.toThrow()
    expect(decSpy).not.toHaveBeenCalled()
  })

  it('adds the termul-command-separator class in decoration onRender', async () => {
    const { terminal, write } = setupTerminal()
    attachCommandSeparators(terminal)

    let capturedRenderCallback: ((el: HTMLElement) => void) | undefined
    vi.spyOn(terminal, 'registerDecoration').mockImplementation((opts) => {
      return {
        marker: opts.marker,
        element: undefined,
        onRender: (cb: (el: HTMLElement) => void) => {
          capturedRenderCallback = cb
          return { dispose: () => {} }
        },
        dispose: () => {},
        isDisposed: false,
        onDispose: () => ({ dispose: () => {} }),
        options: {}
      } as any
    })

    await write('out\r\n\r\n\x1b]133;A;termul\x07\r\ncmd\r\n')
    expect(capturedRenderCallback).toBeDefined()

    const dummyEl = document.createElement('div')
    capturedRenderCallback!(dummyEl)
    expect(dummyEl.classList.contains('termul-command-separator')).toBe(true)
  })

  it('no-ops safely on terminals without parser or decoration APIs', () => {
    const mockTerm = {} as unknown as Terminal
    expect(() => attachCommandSeparators(mockTerm)).not.toThrow()
  })

  it('draws no line for plain 133;A even with a spaced fixture', async () => {
    const { terminal, write } = setupTerminal()
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    await write('out\r\n\r\n\x1b]133;A\x07\r\ncmd\r\n')
    expect(decSpy).not.toHaveBeenCalled()
  })

  it('draws no line when the row directly above anchor is non-blank', async () => {
    const { terminal, write } = setupTerminal()
    const decSpy = vi.spyOn(terminal, 'registerDecoration')
    attachCommandSeparators(terminal)

    await write('out\r\n\x1b]133;A;termul\x07cmd\r\n')
    expect(decSpy).not.toHaveBeenCalled()
  })
})
