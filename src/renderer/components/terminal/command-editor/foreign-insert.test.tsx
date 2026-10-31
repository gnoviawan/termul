import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { commandDraftStore } from '@/lib/command-lifecycle/draft-store'
import { sessionStore } from '@/lib/command-lifecycle/session-store'
import { completionView } from './completion-view'
import { draftPersistence } from './draft-persistence'
import { editorKeymap } from './editor-keys'
import { type EditorInputTarget, routeForeignInsert, routeMobileKey } from './foreign-insert'
import { TerminalInputSurface } from './TerminalInputSurface'

const terminalId = 'foreign-insert-terminal'
const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement
    view.destroy()
    parent?.remove()
  }
  commandDraftStore.processExited(terminalId)
  sessionStore.reset()
})

function mountEditor(doc: string, anchor: number, extensions: Extension = []) {
  commandDraftStore.offer(terminalId, 'Editor', doc)
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [draftPersistence(terminalId, commandDraftStore), extensions]
    })
  })
  views.push(view)
  return view
}

function target(view: EditorView | null): EditorInputTarget {
  return {
    ptyId: () => 'pty-foreign',
    mode: () => 'Editor',
    view: () => view,
    terminalId,
    allowWrite: () => true,
    scrollPages: () => {}
  }
}

it.each([
  ['bidi format', '\u202e'],
  ['zero-width format', '\u200b'],
  ['C1 control', '\u009b']
])('refuses %s in assist/history inserts with and without a mounted view', (_name, control) => {
  const write = vi.fn()
  const view = mountEditor('safe draft', 10)
  const onError = vi.fn()

  for (const kind of ['assist', 'history'] as const) {
    for (const destination of [target(view), target(null)]) {
      routeForeignInsert(destination, kind, `echo safe${control}`, write, onError)
      expect(view.state.doc.toString()).toBe('safe draft')
      expect(commandDraftStore.read(terminalId)).toBe('safe draft')
    }
  }

  expect(write).not.toHaveBeenCalled()
  expect(onError).toHaveBeenCalledTimes(4)
})

it('assist text inserts into the editor', () => {
  const write = vi.fn()
  let insertedByUserEvent = false
  const view = mountEditor(
    'git status',
    4,
    EditorView.updateListener.of((update) => {
      insertedByUserEvent ||= update.transactions.some((tr) => tr.isUserEvent('input.insert'))
    })
  )

  routeForeignInsert(target(view), 'assist', 'remote ', write)

  expect(write).not.toHaveBeenCalled()
  expect(view.state.doc.toString()).toBe('git remote status')
  expect(view.state.selection.main.head).toBe(11)
  expect(insertedByUserEvent).toBe(true)
  expect(commandDraftStore.read(terminalId)).toBe('git remote status')

  routeForeignInsert(target(null), 'assist', ' --short', write)

  expect(commandDraftStore.read(terminalId)).toBe('git remote status --short')
  expect(write).not.toHaveBeenCalled()
})

it('history text inserts into the editor', () => {
  const write = vi.fn()
  const submit = vi.fn()
  const view = mountEditor('unsent draft', 3, editorKeymap({ history: () => [], submit }))

  routeForeignInsert(target(view), 'history', 'git log', write)

  expect(write).not.toHaveBeenCalled()
  expect(view.state.doc.toString()).toBe('git log')
  expect(view.state.selection.main.head).toBe(7)
  expect(commandDraftStore.read(terminalId)).toBe('git log')
  expect(submit).not.toHaveBeenCalled()

  routeForeignInsert(target(null), 'history', 'pwd', write)

  expect(commandDraftStore.read(terminalId)).toBe('pwd')
  expect(write).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it('mobile bar edits the draft', () => {
  const write = vi.fn()
  let requests = 0
  let popupOpen = true
  let popupPosition = 0
  const view = mountEditor('git status', 4, [
    completionView({
      rows: () => [],
      request: () => {
        requests++
      }
    }),
    editorKeymap({
      history: () => [],
      submit: () => {
        throw new Error('Mobile editing must not submit')
      },
      historyPopup: () => ({
        open: popupOpen,
        move: (direction) => {
          popupPosition += direction
        },
        highlightedValue: undefined,
        close: () => {
          popupOpen = false
        }
      })
    })
  ])
  const destination = target(view)
  const key = (text: string) => routeMobileKey(destination, 'key', text, write)

  key('\x1b[D')
  expect(write).not.toHaveBeenCalled()
  expect(view.state.selection.main.head).toBe(3)
  key('\x1b[C')
  expect(view.state.selection.main.head).toBe(4)
  key('\x1b[A')
  expect(popupPosition).toBe(-1)
  key('\x1b[B')
  expect(popupPosition).toBe(0)
  key('\t')
  expect(requests).toBe(1)
  key('\x1b')
  expect(popupOpen).toBe(false)
  expect(view.state.doc.toString()).toBe('git status')
  key('\x03')
  expect(view.state.doc.toString()).toBe('')

  routeMobileKey(destination, 'paste', '\x1b[200~echo\x00 hi\r\nthere\x1b[201~', write)

  expect(view.state.doc.toString()).toBe('echo hi\nthere')
  expect(commandDraftStore.read(terminalId)).toBe('echo hi\nthere')
  for (const text of ['\x1b[D', '\x1b[C', '\x1b[A', '\x1b[B', '\t', '\x1b', '\x03']) {
    routeMobileKey(target(null), 'key', text, write)
  }
  routeMobileKey(target(null), 'paste', 'ignored', write)
  expect(commandDraftStore.read(terminalId)).toBe('echo hi\nthere')
  expect(write).not.toHaveBeenCalled()
})

it('assist control characters are refused', () => {
  const write = vi.fn()
  const view = mountEditor('keep draft', 4)
  const errors: string[] = []
  for (const destination of [target(view), target(null)]) {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      routeForeignInsert(
        destination,
        'assist',
        `echo${String.fromCharCode(code)}hi`,
        write,
        (message) => {
          errors.push(message)
        }
      )

      expect(view.state.doc.toString()).toBe('keep draft')
      expect(commandDraftStore.read(terminalId)).toBe('keep draft')
      expect(write).not.toHaveBeenCalled()
    }
  }
  expect(errors).toHaveLength(66)
})

it('history control characters are refused', () => {
  const write = vi.fn()
  const view = mountEditor('keep draft', 4)
  const errors: string[] = []
  for (const destination of [target(view), target(null)]) {
    for (const text of [
      'echo hi\necho there',
      ...Array.from({ length: 32 }, (_, code) => `echo${String.fromCharCode(code)}hi`),
      'echo\x7fhi'
    ]) {
      routeForeignInsert(destination, 'history', text, write, (message) => {
        errors.push(message)
      })

      expect(view.state.doc.toString()).toBe('keep draft')
      expect(commandDraftStore.read(terminalId)).toBe('keep draft')
      expect(write).not.toHaveBeenCalled()
    }
  }
  expect(errors).toHaveLength(68)
})

it('view-only client does not complete or submit', () => {
  const write = vi.fn()
  const requestCompletion = vi.fn()
  const view = mountEditor('git st', 6, [
    completionView({ rows: () => [], request: requestCompletion }),
    editorKeymap({ history: () => [], submit: write })
  ])
  const { container, unmount } = render(
    <TerminalInputSurface
      mode="Editor"
      allowWrite={false}
      focused={true}
      terminalId={terminalId}
      keymapDeps={{ history: () => [], submit: write }}
    >
      {null}
    </TerminalInputSurface>
  )
  const editor = container.querySelector('.cm-content') ?? container.firstElementChild!
  fireEvent.keyDown(editor, { key: 'Tab' })
  fireEvent.keyDown(editor, { key: 'Enter' })
  for (const text of ['\t', '\r', '\x1b[D']) {
    routeMobileKey({ ...target(view), allowWrite: () => false }, 'key', text, write)
  }

  expect(container.querySelector('.cm-editor')).toBeNull()
  expect(write).not.toHaveBeenCalled()
  expect(requestCompletion).not.toHaveBeenCalled()
  unmount()
})

it('page keys scroll and do not write', () => {
  const write = vi.fn()
  const scrollPages = vi.fn()
  const view = mountEditor('git status', 4)
  const destination = { ...target(view), scrollPages }

  routeMobileKey(destination, 'key', '\x1b[5~', write)
  routeMobileKey(destination, 'key', '\x1b[6~', write)

  expect(scrollPages.mock.calls).toEqual([[-1], [1]])
  expect(write).not.toHaveBeenCalled()
})

it("writable PTY keeps today's write", () => {
  const write = vi.fn()
  const destination: EditorInputTarget = {
    ...target(null),
    mode: () => 'PTY'
  }

  routeMobileKey(destination, 'key', '\t', write)
  routeMobileKey(destination, 'paste', 'git status', write)

  expect(write.mock.calls).toEqual([['\t'], ['git status']])
})

it('PTY assist still refuses control characters', () => {
  const write = vi.fn()
  const errors: string[] = []
  const destination: EditorInputTarget = {
    ...target(null),
    mode: () => 'PTY'
  }

  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    routeForeignInsert(
      destination,
      'assist',
      `echo${String.fromCharCode(code)}hi`,
      write,
      (message) => {
        errors.push(message)
      }
    )
  }

  expect(write).not.toHaveBeenCalled()
  expect(errors).toHaveLength(33)
})

it('view-only PTY sends nothing', () => {
  const write = vi.fn()
  const requestCompletion = vi.fn()
  const view = mountEditor(
    'git st',
    6,
    completionView({ rows: () => [], request: requestCompletion })
  )
  const destination: EditorInputTarget = {
    ...target(view),
    mode: () => 'PTY',
    allowWrite: () => false
  }

  for (const text of ['\t', '\r', '\x1b[D']) {
    routeMobileKey(destination, 'key', text, write)
  }
  routeMobileKey(destination, 'paste', 'git status', write)

  expect(write).not.toHaveBeenCalled()
  expect(requestCompletion).not.toHaveBeenCalled()
})

it('submitting phase drops foreign insert, paste, and mobile keys except Ctrl+C', () => {
  const write = vi.fn()
  sessionStore.apply(terminalId, { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  sessionStore.apply(terminalId, {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  expect(sessionStore.beginSubmit(terminalId)).not.toBeNull()
  expect(sessionStore.read(terminalId).phase).toBe('Submitting')

  const destination: EditorInputTarget = {
    ...target(null),
    mode: () => 'PTY'
  }

  routeForeignInsert(destination, 'assist', 'git status', write)
  routeForeignInsert(destination, 'history', 'git log', write)
  routeMobileKey(destination, 'key', '\t', write)
  routeMobileKey(destination, 'paste', 'git status', write)
  expect(write).not.toHaveBeenCalled()

  routeMobileKey(destination, 'key', '\x03', write)
  expect(write).toHaveBeenCalledExactlyOnceWith('\x03')
})
