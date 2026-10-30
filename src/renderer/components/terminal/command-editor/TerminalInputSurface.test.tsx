import { readFileSync } from 'node:fs'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCommandDraftStore } from '@/lib/command-lifecycle/draft-store'
import { sessionStore } from '@/lib/command-lifecycle/session-store'
import { TerminalInputSurface } from './TerminalInputSurface'

const geometryMethods = ['getClientRects', 'getBoundingClientRect'] as const
const originalGeometry = geometryMethods.map((name) =>
  Object.getOwnPropertyDescriptor(Range.prototype, name)
)

beforeAll(() => {
  // jsdom has no layout; CodeMirror still needs the Range geometry API.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => []
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect()
  })
})

afterAll(() => {
  geometryMethods.forEach((name, index) => {
    const original = originalGeometry[index]
    if (original) Object.defineProperty(Range.prototype, name, original)
    else delete Range.prototype[name]
  })
})

describe('TerminalInputSurface', () => {
  it('scrollback click keeps editor focus', () => {
    const { container, rerender } = render(
      <TerminalInputSurface mode="Editor" focused={true} terminalId="terminal-a">
        <textarea aria-label="Terminal input" />
      </TerminalInputSurface>
    )
    const composer = screen.getByRole('textbox', { name: 'Command editor' })
    const terminalInput = screen.getByRole('textbox', { name: 'Terminal input' })
    const slot = terminalInput.parentElement!
    let mouseDownReachedSurface = false
    container.addEventListener('mousedown', (event) => {
      mouseDownReachedSurface = true
      expect(event.defaultPrevented).toBe(false)
    })

    fireEvent.mouseDown(slot)
    slot.focus()
    fireEvent.mouseUp(slot)
    fireEvent.click(slot)
    expect(document.activeElement).toBe(composer)
    expect(mouseDownReachedSurface).toBe(true)

    // xterm can focus its textarea from its own click handler.
    fireEvent.mouseDown(terminalInput)
    terminalInput.focus()
    fireEvent.mouseUp(terminalInput)
    fireEvent.click(terminalInput)
    expect(document.activeElement).toBe(composer)

    rerender(
      <TerminalInputSurface mode="PTY" focused={true} terminalId="terminal-a">
        <textarea aria-label="Terminal input" />
      </TerminalInputSurface>
    )
    terminalInput.focus()
    expect(document.activeElement).toBe(terminalInput)
  })

  it('prompt mounting does not steal focus from another pane or control', () => {
    const otherInput = document.createElement('input')
    document.body.appendChild(otherInput)
    otherInput.focus()

    render(
      <div data-pane-content="pane-a">
        <TerminalInputSurface mode="Editor" focused={true} terminalId="pane-a-terminal">
          {null}
        </TerminalInputSurface>
      </div>
    )

    expect(document.activeElement).toBe(otherInput)
    otherInput.remove()
  })

  it('background prompt does not steal focus', () => {
    const { rerender, unmount } = render(
      <TerminalInputSurface mode="Editor" focused={false} terminalId="terminal-a">
        {null}
      </TerminalInputSurface>
    )

    const composer = screen.getByRole('textbox', { name: 'Command editor' })
    expect(document.activeElement).not.toBe(composer)

    rerender(
      <TerminalInputSurface mode="Editor" focused={true} terminalId="terminal-a">
        {null}
      </TerminalInputSurface>
    )

    expect(document.activeElement).toBe(composer)
    expect(screen.getByRole('textbox', { name: 'Command editor' })).toBe(composer)

    rerender(
      <TerminalInputSurface mode="Editor" focused={false} terminalId="terminal-a">
        {null}
      </TerminalInputSurface>
    )

    expect(document.activeElement).toBe(composer)
    unmount()

    render(
      <TerminalInputSurface mode="Editor" focused={true} terminalId="terminal-a">
        {null}
      </TerminalInputSurface>
    )

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Command editor' }))
  })

  it('surface follows the mode', () => {
    const { rerender } = render(
      <TerminalInputSurface mode="Editor" focused={false} terminalId="terminal-a">
        <div data-testid="xterm-slot">Continuous scrollback</div>
      </TerminalInputSurface>
    )

    expect(screen.getByRole('textbox', { name: 'Command editor' })).toBeInTheDocument()
    const slot = screen.getByTestId('xterm-slot').parentElement!
    expect(slot).toHaveAttribute('data-keyboard-target', 'false')
    expect(slot).toHaveAttribute('tabindex', '-1')
    expect(slot).not.toHaveAttribute('inert')
    expect(slot).not.toHaveAttribute('aria-hidden')

    // The Executing phase arrives as mode PTY; the reducer owns that mapping.
    rerender(
      <TerminalInputSurface mode="PTY" focused={false} terminalId="terminal-a">
        <div data-testid="xterm-slot">Continuous scrollback</div>
      </TerminalInputSurface>
    )

    expect(screen.queryByRole('textbox', { name: 'Command editor' })).not.toBeInTheDocument()
    expect(screen.getByTestId('xterm-slot')).toBeVisible()
    expect(slot).toHaveAttribute('data-keyboard-target', 'true')
    expect(slot).not.toHaveAttribute('tabindex')
  })
})

it('live editor remounts its draft', () => {
  const draftStore = createCommandDraftStore()
  const mount = () =>
    render(
      <TerminalInputSurface
        mode="Editor"
        focused={false}
        terminalId="terminal-a"
        draftStore={draftStore}
      >
        {null}
      </TerminalInputSurface>
    )
  const first = mount()
  const editor = screen.getByRole('textbox', { name: 'Command editor' })
  const view = EditorView.findFromDOM(editor)!
  act(() => view.dispatch({ changes: { from: 0, insert: 'make test' } }))
  first.unmount()
  mount()
  expect(screen.getByRole('textbox', { name: 'Command editor' })).toHaveTextContent('make test')
})

it('raw remount does not show the draft', () => {
  const draftStore = createCommandDraftStore()
  draftStore.offer('terminal-a', 'Editor', 'make test')
  const { rerender } = render(
    <TerminalInputSurface
      mode="raw"
      focused={false}
      terminalId="terminal-a"
      draftStore={draftStore}
    >
      {null}
    </TerminalInputSurface>
  )
  expect(screen.queryByRole('textbox', { name: 'Command editor' })).not.toBeInTheDocument()
  expect(draftStore.read('terminal-a')).toBe('make test')
  rerender(
    <TerminalInputSurface
      mode="PTY"
      focused={false}
      terminalId="terminal-a"
      draftStore={draftStore}
    >
      {null}
    </TerminalInputSurface>
  )
  expect(screen.queryByRole('textbox', { name: 'Command editor' })).not.toBeInTheDocument()
  expect(draftStore.read('terminal-a')).toBe('make test')
})

describe('mounted composer keymap', () => {
  it('runs history, clear, EOF, readline and newline bindings with lazy deps', () => {
    const sendEof = vi.fn()
    const submit = vi.fn()
    const surface = (entries: string[]) => (
      <TerminalInputSurface
        mode="Editor"
        focused={true}
        terminalId="keymap-terminal"
        draftStore={draftStore}
        keymapDeps={{ history: () => entries, submit, sendEof }}
      >
        {null}
      </TerminalInputSurface>
    )
    const draftStore = createCommandDraftStore()
    const { rerender } = render(surface(['git status']))
    const view = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Command editor' }))!
    const press = (key: string, modifiers: KeyboardEventInit = {}) =>
      act(() => {
        expect(
          runScopeHandlers(view, new KeyboardEvent('keydown', { key, ...modifiers }), 'editor')
        ).toBe(true)
      })
    press('ArrowUp')
    expect(view.state.doc.toString()).toBe('git status')
    press('a', { ctrlKey: true })
    expect(view.state.selection.main.head).toBe(0)
    press('Enter', { shiftKey: true })
    expect(view.state.doc.toString()).toBe('\ngit status')
    expect(submit).not.toHaveBeenCalled()
    press('c', { ctrlKey: true })
    expect(view.state.doc.toString()).toBe('')
    press('d', { ctrlKey: true })
    expect(sendEof).toHaveBeenCalledOnce()
    rerender(surface(['make test']))
    expect(EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Command editor' }))).toBe(
      view
    )
    press('ArrowUp')
    expect(view.state.doc.toString()).toBe('make test')
  })
})

it('native clipboard paste sanitizes controls and bracket wrappers', () => {
  render(
    <TerminalInputSurface
      mode="Editor"
      focused={true}
      terminalId="native-paste"
      draftStore={createCommandDraftStore()}
    >
      {null}
    </TerminalInputSurface>
  )
  const editor = screen.getByRole('textbox', { name: 'Command editor' })
  const view = EditorView.findFromDOM(editor)!
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: () => '\x1b[200~echo\x00 hi\x1b[201~\r\n',
      files: []
    }
  })
  act(() => {
    editor.dispatchEvent(event)
  })
  expect(view.state.doc.toString()).toBe('echo hi\n')
})

it('terminal switch focuses the new view and restores its own draft', () => {
  const draftStore = createCommandDraftStore()
  draftStore.offer('focus-a', 'Editor', 'draft A')
  draftStore.offer('focus-b', 'Editor', 'draft B')
  const surface = (terminalId: string) => (
    <TerminalInputSurface
      mode="Editor"
      focused={true}
      terminalId={terminalId}
      draftStore={draftStore}
    >
      {null}
    </TerminalInputSurface>
  )
  const { rerender } = render(surface('focus-a'))
  const first = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Command editor' }))!
  expect(first.state.doc.toString()).toBe('draft A')
  expect(first.hasFocus).toBe(true)
  rerender(surface('focus-b'))
  const next = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Command editor' }))!
  expect(next).not.toBe(first)
  expect(next.state.doc.toString()).toBe('draft B')
  expect(next.hasFocus).toBe(true)
})

function mountComposition() {
  const draftStore = createCommandDraftStore()
  draftStore.offer('ime', 'Editor', 'ls ')
  const submit = vi.fn()
  const mount = () =>
    render(
      <TerminalInputSurface
        mode="Editor"
        focused={true}
        terminalId="ime"
        draftStore={draftStore}
        keymapDeps={{ history: () => [], submit }}
      >
        {null}
      </TerminalInputSurface>
    )
  const mounted = mount()
  const editor = screen.getByRole('textbox', { name: 'Command editor' })
  const view = EditorView.findFromDOM(editor)!
  fireEvent.compositionStart(editor)
  expect(view.compositionStarted).toBe(true)
  act(() =>
    view.dispatch({ changes: { from: 3, insert: '日本' }, userEvent: 'input.type.compose' })
  )
  // Direct dispatch cannot run CodeMirror's native DOM input increment in jsdom.
  expect(view.composing).toBe(false)
  return { draftStore, submit, mount, mounted, editor, view }
}

it('IME preedit stays out of the draft across unmount and remount', () => {
  const { draftStore, mounted, mount } = mountComposition()
  expect(draftStore.read('ime')).toBe('ls ')
  mounted.unmount()
  mount()
  expect(screen.getByRole('textbox', { name: 'Command editor' })).toHaveTextContent('ls')
  expect(
    EditorView.findFromDOM(
      screen.getByRole('textbox', { name: 'Command editor' })
    )!.state.doc.toString()
  ).toBe('ls ')
})

it('IME commit offers the final document once', async () => {
  const { draftStore, editor, view } = mountComposition()
  const offer = vi.spyOn(draftStore, 'offer')
  act(() =>
    view.dispatch({
      changes: { from: 3, to: 5, insert: 'にほん' },
      userEvent: 'input.type.compose'
    })
  )
  fireEvent.compositionEnd(editor, { data: '日本語' })
  act(() =>
    view.dispatch({
      changes: { from: 3, to: 6, insert: '日本語' },
      userEvent: 'input.type.compose'
    })
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(draftStore.read('ime')).toBe('ls 日本語')
  expect(offer).toHaveBeenCalledExactlyOnceWith('ime', 'Editor', 'ls 日本語')
})

it('IME cancellation keeps the committed draft', async () => {
  const { draftStore, editor, view } = mountComposition()
  expect(draftStore.read('ime')).toBe('ls ')
  act(() => view.dispatch({ changes: { from: 3, to: 5 }, userEvent: 'input.type.compose' }))
  fireEvent.compositionEnd(editor, { data: '' })
  await act(async () => {
    await Promise.resolve()
  })
  expect(draftStore.read('ime')).toBe('ls ')
})

it('IME Enter does not submit the mounted composer', () => {
  const { editor, submit } = mountComposition()
  fireEvent.keyDown(editor, { key: 'Enter', keyCode: 13, isComposing: true })
  expect(submit).not.toHaveBeenCalled()
})

it.each([
  true,
  false
])('Editor exit restores terminal focus only for a focused pane (%s)', (focused) => {
  const focusTerminal = vi.fn(() => screen.getByRole('textbox', { name: 'terminal input' }).focus())
  const surface = (mode: 'Editor' | 'PTY') => (
    <TerminalInputSurface
      mode={mode}
      focused={focused}
      terminalId="focus-exit"
      focusTerminal={focusTerminal}
      draftStore={createCommandDraftStore()}
    >
      <input aria-label="terminal input" />
    </TerminalInputSurface>
  )
  const { rerender } = render(surface('Editor'))
  screen.getByRole('textbox', { name: 'Command editor' }).focus()
  rerender(surface('PTY'))
  const terminalInput = screen.getByRole('textbox', { name: 'terminal input' })
  if (focused) {
    expect(document.activeElement).toBe(terminalInput)
    expect(focusTerminal).toHaveBeenCalledOnce()
  } else {
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(terminalInput)
  }
})

it('IME commit waits for CodeMirror to flush pending DOM changes', async () => {
  const { draftStore, editor } = mountComposition()
  const offer = vi.spyOn(draftStore, 'offer')
  act(() => {
    editor.querySelector('.cm-line')!.textContent = 'ls 日本語'
    fireEvent.compositionEnd(editor, { data: '日本語' })
  })
  await act(async () => {
    await Promise.resolve()
  })
  expect(draftStore.read('ime')).toBe('ls 日本語')
  expect(offer).toHaveBeenCalledExactlyOnceWith('ime', 'Editor', 'ls 日本語')
})

it('the surface reads the session store', () => {
  const source = readFileSync('src/renderer/components/terminal/ConnectedTerminal.tsx', 'utf8')
  expect(source).toMatch(/sessionStore/)
  expect(source).toContain('mode={inputMode}')
  expect(source).not.toMatch(/useState<InputMode>/)
})

it('submitting surface discards input but lets configured app shortcuts bubble', () => {
  const id = 'submitting-surface'
  sessionStore.apply(id, { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  sessionStore.apply(id, {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  expect(sessionStore.beginSubmit(id)).not.toBeNull()
  try {
    render(
      <TerminalInputSurface
        mode="PTY"
        focused={true}
        terminalId={id}
        draftStore={createCommandDraftStore()}
        keymapDeps={{
          shortcuts: () => ({ commandPalette: { defaultKey: 'ctrl+k', customKey: null } }) as never
        }}
      >
        <input aria-label="terminal input" />
      </TerminalInputSurface>
    )
    const terminalInput = screen.getByRole('textbox', { name: 'terminal input' })
    const keyA = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    terminalInput.dispatchEvent(keyA)
    expect(keyA.defaultPrevented).toBe(true)

    const commandPalette = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })
    terminalInput.dispatchEvent(commandPalette)
    expect(commandPalette.defaultPrevented).toBe(false)

    const ctrlC = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })
    terminalInput.dispatchEvent(ctrlC)
    expect(ctrlC.defaultPrevented).toBe(false)
  } finally {
    sessionStore.reset()
  }
})
