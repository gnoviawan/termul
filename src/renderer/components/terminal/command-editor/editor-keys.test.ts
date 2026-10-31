import { readFileSync } from 'node:fs'
import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createCommandDraftStore } from '@/lib/command-lifecycle/draft-store'
import { isAppOwnedTerminalShortcut } from '../keymap'
import {
  applyEditorPaste,
  editorKeymap,
  handleTerminalImagePaste,
  handleTerminalPaste,
  sanitizeEditorPaste
} from './editor-keys'

describe('applyEditorPaste', () => {
  it('multiline paste stays in the editor', () => {
    const state = EditorState.create({
      doc: 'before old after',
      selection: { anchor: 7, head: 10 }
    })
    const writePty = vi.fn()

    const next = applyEditorPaste(state, { type: 'text', text: 'echo hi\necho there' }, writePty)

    expect(writePty).not.toHaveBeenCalled()
    expect(next.doc.toString()).toBe('before echo hi\necho there after')
    expect(next.selection.main.anchor).toBe(25)
    expect(next.selection.main.head).toBe(25)
  })

  it('paste drops hidden controls', () => {
    const state = EditorState.create({
      doc: 'before old after',
      selection: { anchor: 7, head: 10 }
    })
    const next = applyEditorPaste(state, {
      type: 'text',
      text: '\x1b[200~echo\x1b hi\x00\x01\x7f\n\tthere\r\nnext\rlast\x1b[201~'
    })

    expect(next.doc.toString()).not.toContain('\x1b')
    expect(next.doc.toString()).toBe('before echo hi\n\tthere\nnext\nlast after')
    expect(next.selection.main.anchor).toBe(31)
    expect(next.selection.main.head).toBe(31)
  })

  it.each([
    ['bidi format', '\u202e'],
    ['zero-width format', '\u200b'],
    ['C1 control', '\u009b']
  ])('paste drops %s while preserving Unicode and whitespace', (_name, control) => {
    const state = EditorState.create({ doc: '', selection: { anchor: 0 } })
    const next = applyEditorPaste(state, {
      type: 'text',
      text: `echo safe${control} café\t\r\nnext`
    })

    expect(next.doc.toString()).toBe('echo safe café\t\nnext')
  })

  it('paste preserves intentional line breaks and tabs', () => {
    expect(sanitizeEditorPaste('echo café\t\r\nnext')).toBe('echo café\t\nnext')
  })

  it('image paste does nothing', () => {
    const state = EditorState.create({ doc: 'keep this draft', selection: { anchor: 5, head: 9 } })
    const writePty = vi.fn()

    const next = applyEditorPaste(state, { type: 'image' }, writePty)

    expect(writePty).not.toHaveBeenCalled()
    expect(next).toBe(state)
    expect(next.doc.toString()).toBe('keep this draft')
    expect(next.selection.main.anchor).toBe(5)
    expect(next.selection.main.head).toBe(9)
  })
})

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement
    view.destroy()
    parent?.remove()
  }
})

function mountEditor(doc: string, deps: Parameters<typeof editorKeymap>[0], anchor = doc.length) {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [history(), editorKeymap(deps)]
    })
  })
  views.push(view)
  return view
}

function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}) {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key, ...modifiers }), 'editor')
}

describe('editorKeymap', () => {
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

  it.each([
    'ArrowUp',
    'ArrowDown'
  ])('moves across a visual wrap before history recall with %s', (key) => {
    const entries = vi.fn(() => ['git status', 'git diff'])
    const view = mountEditor('git ', { history: entries, submit: vi.fn() })
    const movement = vi.spyOn(view, 'moveVertically').mockImplementation((range) => range)
    if (key === 'ArrowDown') {
      press(view, 'ArrowUp')
      view.dispatch({ selection: { anchor: 3 } })
      entries.mockClear()
    }
    const originalDoc = view.state.doc.toString()
    // Up starts on the second visual row; Down starts above the last visual row.
    vi.spyOn(view, 'coordsAtPos').mockImplementation((pos) => {
      const wrapAt = key === 'ArrowUp' ? 3 : 6
      const top = pos < wrapAt ? 0 : 20
      return { left: 0, right: 1, top, bottom: top + 20 }
    })
    const head = key === 'ArrowUp' ? 1 : 7
    movement.mockReturnValue(EditorSelection.cursor(head))
    press(view, key)
    expect(view.state.doc.toString()).toBe(originalDoc)
    expect(view.state.selection.main.head).toBe(head)
    expect(movement).toHaveBeenCalledWith(expect.anything(), key === 'ArrowDown')
    expect(entries).not.toHaveBeenCalled()
  })

  it('first Up on the top visual row recalls instead of clamping to document start', () => {
    const view = mountEditor('git st', { history: () => ['git status'], submit: vi.fn() }, 6)
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 0, right: 1, top: 0, bottom: 20 })
    vi.spyOn(view, 'moveVertically').mockReturnValue(EditorSelection.cursor(0))

    expect(press(view, 'ArrowUp')).toBe(true)

    expect(view.state.doc.toString()).toBe('git status')
    expect(view.state.selection.main.head).toBe(10)
  })

  it('first Down on the last visual row restores the draft instead of clamping to document end', () => {
    const view = mountEditor('git st', { history: () => ['git status'], submit: vi.fn() })
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 0, right: 1, top: 0, bottom: 20 })
    vi.spyOn(view, 'moveVertically').mockImplementation((range) => range)
    press(view, 'ArrowUp')
    expect(view.state.doc.toString()).toBe('git status')
    view.dispatch({ selection: { anchor: 3 } })
    vi.mocked(view.moveVertically).mockReturnValue(EditorSelection.cursor(10))

    expect(press(view, 'ArrowDown')).toBe(true)

    expect(view.state.doc.toString()).toBe('git st')
    expect(view.state.selection.main.head).toBe(6)
  })

  it('recall row follows the caret side', () => {
    const line = 'echo hello from the wrapped command line'
    const amended = `${line} --amend`
    const wrapAt = 20
    const coords = (pos: number, side = 1) => {
      const onFirst = pos < wrapAt || (pos === wrapAt && side < 0)
      const top = onFirst ? 0 : 20
      return { left: 0, right: 1, top, bottom: top + 20 }
    }

    const upEnd = mountEditor(line, { history: () => [amended], submit: vi.fn() }, wrapAt)
    vi.spyOn(upEnd, 'coordsAtPos').mockImplementation(coords)
    vi.spyOn(upEnd, 'moveVertically').mockImplementation((range) => range)
    upEnd.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(wrapAt, -1)]) })
    expect(press(upEnd, 'ArrowUp')).toBe(true)
    expect(upEnd.state.doc.toString()).toBe(amended)

    const upStart = mountEditor(line, { history: () => [amended], submit: vi.fn() }, wrapAt)
    vi.spyOn(upStart, 'coordsAtPos').mockImplementation(coords)
    vi.spyOn(upStart, 'moveVertically').mockReturnValue(EditorSelection.cursor(1))
    upStart.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(wrapAt, 1)]) })
    expect(press(upStart, 'ArrowUp')).toBe(true)
    expect(upStart.state.doc.toString()).toBe(line)
    expect(upStart.state.selection.main.head).toBe(1)

    const downView = mountEditor(line, { history: () => [amended], submit: vi.fn() }, wrapAt)
    vi.spyOn(downView, 'coordsAtPos').mockImplementation(coords)
    const downMove = vi.spyOn(downView, 'moveVertically').mockImplementation((range) => range)
    downView.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(wrapAt, -1)]) })
    expect(press(downView, 'ArrowUp')).toBe(true)
    expect(downView.state.doc.toString()).toBe(amended)

    downView.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(wrapAt, -1)]) })
    downMove.mockReturnValue(EditorSelection.cursor(wrapAt + 4, 1))
    expect(press(downView, 'ArrowDown')).toBe(true)
    expect(downView.state.doc.toString()).toBe(amended)
    expect(downView.state.selection.main.head).toBe(wrapAt + 4)

    downView.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(wrapAt, 1)]) })
    expect(press(downView, 'ArrowDown')).toBe(true)
    expect(downView.state.doc.toString()).toBe(line)
  })

  it('readline keys edit the draft', () => {
    const writePty = vi.fn()
    const cases = [
      { key: 'a', anchor: 7, text: 'git status', head: 0 },
      { key: 'e', anchor: 4, text: 'git status', head: 10 },
      { key: 'k', anchor: 4, text: 'git ', head: 4 },
      { key: 'u', anchor: 4, text: 'status', head: 0 },
      { key: 'w', anchor: 10, text: 'git ', head: 4 }
    ]
    for (const { key, anchor, text, head } of cases) {
      const view = mountEditor(
        'git status',
        { history: () => [], submit: () => {}, writePty },
        anchor
      )
      expect(press(view, key, { ctrlKey: true })).toBe(true)
      expect(view.state.doc.toString()).toBe(text)
      expect(view.state.selection.main.head).toBe(head)
    }
    for (const key of ['a', 'e', 'k', 'u', 'w', 'c', 'd']) {
      const shortcuts = {
        commandPalette: { defaultKey: `ctrl+${key}`, customKey: null }
      } as Parameters<typeof isAppOwnedTerminalShortcut>[1]
      const event = new KeyboardEvent('keydown', { key, ctrlKey: true })
      expect(isAppOwnedTerminalShortcut(event, shortcuts)).toBe(true)
      const view = mountEditor(
        'git status',
        {
          history: () => [],
          submit: () => {},
          writePty,
          shortcuts: () => shortcuts
        },
        4
      )
      expect(runScopeHandlers(view, event, 'editor')).toBe(false)
      expect(view.state.doc.toString()).toBe('git status')
      expect(view.state.selection.main.head).toBe(4)
    }
    expect(writePty).not.toHaveBeenCalled()
  })

  it('Up recalls history on the first line', () => {
    const submit = vi.fn()
    const view = mountEditor('', { history: () => ['git status'], submit })

    press(view, 'ArrowUp')

    expect(view.state.doc.toString()).toBe('git status')
    expect(submit).not.toHaveBeenCalled()
  })

  it('Up on the first line uses the prefix', () => {
    const submit = vi.fn()
    const view = mountEditor('git', { history: () => ['git status', 'make test'], submit })
    // Without layout, history uses document-line boundaries.
    vi.spyOn(view, 'coordsAtPos').mockReturnValue(null)

    press(view, 'ArrowUp')

    expect(view.state.doc.toString()).toBe('git status')
    expect(submit).not.toHaveBeenCalled()
  })

  it('Down restores the unsent draft', () => {
    const submit = vi.fn()
    let history = ['git status']
    const view = mountEditor('git', { history: () => history, submit })
    // Without layout, these drafts use document-line boundaries in both directions.
    vi.spyOn(view, 'coordsAtPos').mockReturnValue(null)

    press(view, 'ArrowUp')
    expect(view.state.doc.toString()).toBe('git status')
    press(view, 'ArrowDown')
    expect(view.state.doc.toString()).toBe('git')

    history = ['git log', 'make test', 'git status']
    press(view, 'ArrowUp')
    expect(view.state.doc.toString()).toBe('git status')
    press(view, 'ArrowUp')
    expect(view.state.doc.toString()).toBe('git log')
    press(view, 'ArrowUp')
    expect(view.state.doc.toString()).toBe('git log')
    press(view, 'ArrowDown')
    expect(view.state.doc.toString()).toBe('git status')
    press(view, 'ArrowDown')
    expect(view.state.doc.toString()).toBe('git')

    press(view, 'ArrowUp')
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'make' } })
    press(view, 'ArrowDown')
    expect(view.state.doc.toString()).toBe('make')
    press(view, 'ArrowUp')
    expect(view.state.doc.toString()).toBe('make test')
    press(view, 'ArrowDown')
    expect(view.state.doc.toString()).toBe('make')
    expect(submit).not.toHaveBeenCalled()
  })

  it('history popup owns Up and Down', () => {
    const rows = ['git status', 'make test', 'echo hello']
    let highlight = 1
    const popup = {
      open: true,
      move: (direction: -1 | 1) => {
        highlight += direction
      },
      get highlightedValue() {
        return rows[highlight]
      },
      close: () => {
        popup.open = false
      }
    }
    const view = mountEditor('', {
      history: () => rows,
      submit: () => {},
      historyPopup: () => popup
    })

    press(view, 'ArrowUp')
    expect(view.state.doc.toString()).toBe('')
    expect(highlight).toBe(0)
    press(view, 'ArrowDown')
    expect(view.state.doc.toString()).toBe('')
    expect(highlight).toBe(1)
  })

  it('Enter on a history row fills the buffer', () => {
    const submit = vi.fn()
    const popup = {
      open: true,
      move: () => {},
      highlightedValue: 'make test',
      close: () => {
        popup.open = false
      }
    }
    const view = mountEditor('make test', {
      history: () => [],
      submit,
      historyPopup: () => popup
    })

    press(view, 'Enter')
    expect(submit).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('make test')
    expect(popup.open).toBe(false)

    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'git' } })
    popup.open = true
    press(view, 'Enter')
    expect(view.state.doc.toString()).toBe('make test')
    expect(popup.open).toBe(false)
    expect(submit).not.toHaveBeenCalled()
  })

  it('Ctrl+R stays an app shortcut', () => {
    const shortcuts = {
      commandHistory: {
        id: 'commandHistory',
        label: 'Command history',
        description: 'Open command history',
        defaultKey: 'ctrl+r'
      }
    }
    const reported: KeyboardEvent[] = []
    const view = mountEditor('git', {
      history: () => [],
      submit: () => {},
      shortcuts: () => shortcuts,
      reportAppShortcut: (event) => reported.push(event)
    })
    const event = new KeyboardEvent('keydown', {
      key: 'r',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })

    expect(isAppOwnedTerminalShortcut(event, shortcuts)).toBe(true)
    expect(runScopeHandlers(view, event, 'editor')).toBe(false)
    expect(reported).toEqual([event])
    expect(view.state.doc.toString()).toBe('git')
    expect(event.defaultPrevented).toBe(false)
    expect(event.cancelBubble).toBe(false)
  })

  it('Up and Down move between multiline rows', () => {
    const view = mountEditor(
      'git\nstatus',
      {
        history: () => ['git log'],
        submit: () => {}
      },
      5
    )

    press(view, 'ArrowUp')
    expect(view.state.doc.toString()).toBe('git\nstatus')
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1)
    press(view, 'ArrowDown')
    expect(view.state.doc.toString()).toBe('git\nstatus')
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2)
  })
  it('Ctrl+C copies editor selection without clearing the draft', () => {
    const copy = vi.fn()
    const view = mountEditor(
      'kubectl delete pod foo',
      {
        history: () => [],
        submit: () => {},
        copy
      },
      7
    )
    view.dispatch({ selection: { anchor: 0, head: 7 } })

    expect(press(view, 'c', { ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('kubectl delete pod foo')
    expect(copy).toHaveBeenCalledExactlyOnceWith('kubectl')
  })

  it('Ctrl+C with only a terminal selection copies terminal text', () => {
    const copy = vi.fn()
    const view = mountEditor('git status', {
      history: () => [],
      submit: () => {},
      selection: () => 'selected output',
      copy
    })

    expect(press(view, 'c', { ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('git status')
    expect(copy).toHaveBeenCalledExactlyOnceWith('selected output')
  })

  it('Ctrl+C clears an unselected buffer', () => {
    const writePty = vi.fn()
    const view = mountEditor('git status', {
      history: () => [],
      submit: () => {},
      writePty
    })

    expect(press(view, 'c', { ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('')
    expect(writePty).not.toHaveBeenCalled()
  })

  it('Ctrl+D on an empty buffer sends EOF', () => {
    const sendEof = vi.fn()
    let leaveRequests = 0
    const view = mountEditor('', {
      history: () => [],
      submit: () => {},
      sendEof,
      leave: () => {
        leaveRequests++
      }
    })

    expect(press(view, 'd', { ctrlKey: true })).toBe(true)
    expect(sendEof).toHaveBeenCalledTimes(1)
    expect(leaveRequests).toBe(0)
    expect(view.state.doc.toString()).toBe('')
  })

  it('Ctrl+D at the end does not delete', () => {
    const sendEof = vi.fn()
    const view = mountEditor('git status', {
      history: () => [],
      submit: () => {},
      sendEof
    })

    expect(press(view, 'd', { ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('git status')
    expect(sendEof).not.toHaveBeenCalled()
  })

  it.each([
    { doc: 'a😀b', anchor: 1, expected: 'ab' },
    { doc: 'e\u0301x', anchor: 0, expected: 'x' }
  ])('Ctrl+D deletes a complete grapheme from $doc', ({ doc, anchor, expected }) => {
    const sendEof = vi.fn()
    const view = mountEditor(doc, { history: () => [], submit: () => {}, sendEof }, anchor)
    expect(press(view, 'd', { ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe(expected)
    expect(sendEof).not.toHaveBeenCalled()
  })

  it('Ctrl+D in the middle deletes one character', () => {
    const sendEof = vi.fn()
    const view = mountEditor(
      'git status',
      {
        history: () => [],
        submit: () => {},
        sendEof
      },
      4
    )

    expect(press(view, 'd', { ctrlKey: true })).toBe(true)
    expect(view.state.doc.toString()).toBe('git tatus')
    expect(view.state.selection.main.head).toBe(4)
    expect(sendEof).not.toHaveBeenCalled()
  })

  it('Shift+Enter inserts a newline', () => {
    const submit = vi.fn()
    const view = mountEditor('git status', { history: () => [], submit }, 3)

    expect(press(view, 'Enter', { shiftKey: true })).toBe(true)
    expect(submit).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('git\n status')
    expect(view.state.selection.main.head).toBe(4)
  })

  it('uncommitted IME text is not submitted', () => {
    const submit = vi.fn()
    const composition = { open: true, text: '日本語' }
    const view = mountEditor('echo ', {
      history: () => [],
      submit,
      composition: () => composition
    })

    const handled = press(view, 'Enter')
    expect(submit).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('echo ')
    expect(handled).toBe(false)

    composition.open = false
    view.dispatch(view.state.replaceSelection(composition.text))
    expect(press(view, 'Enter')).toBe(true)
    expect(submit).toHaveBeenCalledExactlyOnceWith('echo 日本語')

    const nativeView = mountEditor('echo ', { history: () => [], submit })
    submit.mockClear()
    expect(press(nativeView, 'Enter', { isComposing: true })).toBe(false)
    expect(nativeView.state.doc.toString()).toBe('echo ')
    expect(submit).not.toHaveBeenCalled()
    Object.defineProperty(nativeView, 'composing', { configurable: true, get: () => true })
    expect(press(nativeView, 'Enter')).toBe(false)
    expect(nativeView.state.doc.toString()).toBe('echo ')
    expect(submit).not.toHaveBeenCalled()
  })

  it('submitting swallows keystrokes', () => {
    const writePty = vi.fn()
    let submitting = true
    const view = mountEditor('git status', {
      history: () => [],
      submit: () => {},
      writePty,
      isSubmitting: () => submitting
    })

    const handled = press(view, 'x')
    view.dispatch({ changes: { from: 10, insert: 'x' }, userEvent: 'input.type' })
    expect(view.state.doc.toString()).toBe('git status')
    expect(handled).toBe(true)
    expect(writePty).not.toHaveBeenCalled()

    submitting = false
    expect(press(view, 'x')).toBe(false)
    view.dispatch({ changes: { from: 10, insert: 'x' }, userEvent: 'input.type' })
    expect(view.state.doc.toString()).toBe('git statusx')
    expect(writePty).not.toHaveBeenCalled()
  })
})

it('keys outside the editor are discarded', () => {
  const store = createCommandDraftStore()
  store.offer('terminal-a', 'Editor', 'git sta')
  store.offer('terminal-a', 'PTY', 'x')
  expect(store.read('terminal-a')).toBe('git sta')
})

it('editor paste does not call terminalApi.write', () => {
  const write = vi.fn()
  const view = mountEditor('', { history: () => [], submit: () => {} })
  handleTerminalPaste(() => 'Editor', view, 'echo hi', write)
  expect(write).not.toHaveBeenCalled()
  expect(view.state.doc.toString()).toBe('echo hi')
  const source = readFileSync('src/renderer/components/terminal/ConnectedTerminal.tsx', 'utf8')
  const pasteText = source.slice(
    source.indexOf('pasteText: async'),
    source.indexOf('onImagePaste: async')
  )
  expect(pasteText.replace(/\s/g, '')).toContain(
    'handleTerminalPaste(()=>inputModeRef.current,commandEditorViewRef.current,text,'
  )
  expect(pasteText).not.toMatch(/sessionStore|session-store/)
  expect(source).toContain('mode={inputMode}')
  expect(source).toContain('viewRef={commandEditorViewRef}')
})

it('an editor image paste does not write 0x16', () => {
  const write = vi.fn()
  const view = mountEditor('keep draft', { history: () => [], submit: () => {} }, 4)
  const before = view.state
  handleTerminalImagePaste(() => 'Editor', view, write)
  expect(write).not.toHaveBeenCalled()
  expect(view.state).toBe(before)
  const source = readFileSync('src/renderer/components/terminal/ConnectedTerminal.tsx', 'utf8')
  const onImagePaste = source.slice(
    source.indexOf('onImagePaste: async'),
    source.indexOf('const copySelectionRef')
  )
  expect(onImagePaste.replace(/\s/g, '')).toContain(
    'handleTerminalImagePaste(()=>inputModeRef.current,commandEditorViewRef.current,'
  )
})

it('editor paste without a mounted view writes nothing', () => {
  const write = vi.fn()
  handleTerminalPaste(() => 'Editor', null, 'echo hi', write)
  expect(write).not.toHaveBeenCalled()
})

it('wrapped editor paste inserts at the caret as one undoable paste transaction', () => {
  const write = vi.fn()
  const view = mountEditor('git status', { history: () => [], submit: () => {} }, 4)
  let pasteEvent = false
  let scrollIntoView = false
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        for (const transaction of update.transactions) {
          if (!transaction.docChanged) continue
          pasteEvent = transaction.isUserEvent('input.paste')
          scrollIntoView = transaction.scrollIntoView
        }
      })
    )
  })

  handleTerminalPaste(() => 'Editor', view, '\x1b[200~echo hi\x1b[201~', write)

  expect(view.state.doc.toString()).toBe('git echo histatus')
  expect(view.state.selection.main.anchor).toBe(11)
  expect(view.state.selection.main.head).toBe(11)
  expect(write).not.toHaveBeenCalled()
  expect(pasteEvent).toBe(true)
  expect(scrollIntoView).toBe(true)
  expect(undo(view)).toBe(true)
  expect(view.state.doc.toString()).toBe('git status')
})

it('editor paste while submitting leaves the document unchanged', () => {
  const write = vi.fn()
  const view = mountEditor(
    'git status',
    { history: () => [], submit: () => {}, isSubmitting: () => true },
    4
  )

  handleTerminalPaste(() => 'Editor', view, '\x1b[200~echo hi\x1b[201~', write)

  expect(view.state.doc.toString()).toBe('git status')
  expect(view.state.selection.main.head).toBe(4)
  expect(write).not.toHaveBeenCalled()
})

it('a PTY paste still writes', () => {
  const write = vi.fn()
  const view = mountEditor('draft', { history: () => [], submit: () => {} })
  for (const mode of ['PTY', 'raw', 'exited'] as const) {
    handleTerminalPaste(() => mode, view, '\x1b[200~echo hi\rthere\x1b[201~', write)
    expect(write).toHaveBeenLastCalledWith('\x1b[200~echo hi\rthere\x1b[201~')
    expect(view.state.doc.toString()).toBe('draft')
    handleTerminalImagePaste(() => mode, view, write)
    expect(write).toHaveBeenLastCalledWith('\x16')
  }
  expect(write).toHaveBeenCalledTimes(6)
})

it('menu paste sanitizes raw text without storing the visible ESC symbol', () => {
  const view = mountEditor('', { history: () => [], submit: () => {} })
  const write = vi.fn()
  handleTerminalPaste(
    () => 'Editor',
    view,
    '\x1b[200~␛[200~echo␛ hi␛[201~\x1b[201~',
    write,
    '\x1b[200~echo\x1b hi\x1b[201~\r'
  )
  expect(view.state.doc.toString()).toBe('echo hi\n')
  expect(view.state.doc.toString()).not.toContain('\x1b')
  expect(view.state.doc.toString()).not.toContain('␛')
  expect(write).not.toHaveBeenCalled()
  handleTerminalPaste(() => 'PTY', view, '\x1b[200~␛ hi\x1b[201~', write, '\x1b hi')
  expect(write).toHaveBeenCalledExactlyOnceWith('\x1b[200~␛ hi\x1b[201~')
})

it('paste sink reads the current mode after clipboard work completes', async () => {
  let mode: 'PTY' | 'Editor' = 'PTY'
  const getMode = () => mode
  const view = mountEditor('', { history: () => [], submit: () => {} })
  const write = vi.fn()
  const pasteText = (text: string) => handleTerminalPaste(getMode, view, text, write)
  const pasteImage = () => handleTerminalImagePaste(getMode, view, write)
  expect(getMode()).toBe('PTY')
  await Promise.resolve()
  mode = 'Editor'
  await pasteText('echo hi')
  await pasteImage()
  expect(write).not.toHaveBeenCalled()
  expect(view.state.doc.toString()).toBe('echo hi')
})
