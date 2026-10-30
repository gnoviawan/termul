import {
  cursorLineDown,
  cursorLineEnd,
  cursorLineStart,
  cursorLineUp,
  deleteCharForward,
  deleteGroupBackward,
  deleteToLineEnd,
  deleteToLineStart
} from '@codemirror/commands'
import { Annotation, EditorState, type Extension, Prec, Transaction } from '@codemirror/state'
import { EditorView, type KeyBinding, keymap } from '@codemirror/view'
import { canTerminalWriteToPty } from '@/lib/command-lifecycle/input-guard'
import type { InputMode } from '@/lib/command-lifecycle/transition'
import type { KeyboardShortcutsConfig } from '@/types/settings'
import { isAppOwnedTerminalShortcut } from '../keymap'

export function sanitizeEditorPaste(text: string): string {
  const normalized = text
    .replaceAll('\x1b[200~', '')
    .replaceAll('\x1b[201~', '')
    .replace(/\r\n?/g, '\n')
  return Array.from(normalized)
    .filter((char) => char === '\n' || char === '\t' || (char >= ' ' && char !== '\x7f'))
    .join('')
}

export function applyEditorPaste(
  state: EditorState,
  payload: { type: 'text'; text: string } | { type: 'image' },
  _writePty?: (text: string) => void
): EditorState {
  if (payload.type === 'image') return state

  return state.update(state.replaceSelection(sanitizeEditorPaste(payload.text))).state
}

export interface EditorKeymapDeps {
  isSubmitting?: () => boolean
  composition?: () => { open: boolean; text: string }
  sendEof?: () => void
  leave?: () => void
  selection?: () => string
  copy?: (text: string) => void
  writePty?: (text: string) => void
  history: () => readonly string[]
  submit: (text: string) => void
  shortcuts?: () => KeyboardShortcutsConfig
  reportAppShortcut?: (event: KeyboardEvent) => void
  historyPopup?: () => {
    open: boolean
    move: (direction: -1 | 1) => void
    highlightedValue: string | undefined
    close: () => void
  }
}

const recallChange = Annotation.define<boolean>()

interface HistoryRecall {
  draft: string
  prefix: string
  offset: number
}

function replaceBuffer(view: EditorView, text: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
    annotations: recallChange.of(true)
  })
}

interface KeymapContext {
  deps: EditorKeymapDeps
  appOwnedEvents: WeakSet<EditorView>
  recalls: WeakMap<EditorView, HistoryRecall>
  composingEvents: WeakMap<EditorView, boolean>
}

function recallHandler(
  { deps, recalls }: KeymapContext,
  view: EditorView,
  direction: -1 | 1
): boolean {
  const popup = deps.historyPopup?.()
  if (popup?.open) {
    popup.move(direction)
    return true
  }
  const line = view.state.doc.lineAt(view.state.selection.main.head).number
  if (direction === -1 && line > 1) return cursorLineUp(view)
  if (direction === 1 && line < view.state.doc.lines) return cursorLineDown(view)
  const selection = view.state.selection.main
  const caret = view.coordsAtPos(selection.head, selection.assoc || 1)
  const boundary = view.coordsAtPos(direction === -1 ? 0 : view.state.doc.length)
  if (caret && boundary && Math.abs(caret.top - boundary.top) >= 1) {
    return direction === 1 ? cursorLineDown(view) : cursorLineUp(view)
  }
  const previous = recalls.get(view)
  if (!previous && direction === 1) return false
  const session = previous ?? {
    draft: view.state.doc.toString(),
    prefix: view.state.doc.line(1).text,
    offset: -1
  }
  const matches = deps.history().filter((entry) => entry.startsWith(session.prefix))
  const offset = session.offset - direction
  if (offset >= matches.length) return true
  if (offset < 0) {
    replaceBuffer(view, session.draft)
    recalls.delete(view)
    return true
  }
  session.offset = offset
  recalls.set(view, session)
  replaceBuffer(view, matches[matches.length - 1 - offset])
  return true
}

function ctrlBindings({ deps, appOwnedEvents }: KeymapContext): KeyBinding[] {
  return [
    {
      key: 'Ctrl-c',
      run: (view) => {
        if (appOwnedEvents.has(view)) return false
        const selection = deps.selection?.() ?? ''
        if (selection) {
          deps.copy?.(selection)
          return true
        }
        replaceBuffer(view, '')
        return true
      }
    },
    {
      key: 'Ctrl-d',
      run: (view) => {
        if (appOwnedEvents.has(view)) return false
        const end = view.state.doc.length
        if (!end) {
          deps.leave?.()
          deps.sendEof?.()
        } else {
          const head = view.state.selection.main.head
          if (head < end) deleteCharForward(view)
        }
        return true
      }
    }
  ]
}

function readlineBindings({ appOwnedEvents }: KeymapContext): KeyBinding[] {
  return [
    { key: 'Ctrl-a', run: cursorLineStart },
    { key: 'Ctrl-e', run: cursorLineEnd },
    { key: 'Ctrl-k', run: deleteToLineEnd },
    { key: 'Ctrl-u', run: deleteToLineStart },
    { key: 'Ctrl-w', run: deleteGroupBackward }
  ].map(({ key, run }) => ({
    key,
    run: (view: EditorView) => (appOwnedEvents.has(view) ? false : run(view))
  }))
}

function enterBindings({ deps, recalls, composingEvents }: KeymapContext): KeyBinding[] {
  const isComposing = (view: EditorView) =>
    deps.composition?.().open ?? (view.composing || composingEvents.get(view) === true)
  return [
    {
      key: 'Shift-Enter',
      run: (view) => {
        if (isComposing(view)) return false
        view.dispatch(view.state.replaceSelection('\n'))
        return true
      }
    },
    {
      key: 'Enter',
      run: (view) => {
        if (isComposing(view)) return false
        const popup = deps.historyPopup?.()
        if (popup?.open) {
          if (popup.highlightedValue !== undefined) replaceBuffer(view, popup.highlightedValue)
          recalls.delete(view)
          popup.close()
          return true
        }
        deps.submit(view.state.doc.toString())
        return true
      }
    }
  ]
}

function eventBinding({ deps, appOwnedEvents, composingEvents }: KeymapContext): KeyBinding {
  return {
    any: (view, event) => {
      composingEvents.set(view, event.isComposing)
      appOwnedEvents.delete(view)
      const shortcuts = deps.shortcuts?.()
      if (shortcuts && isAppOwnedTerminalShortcut(event, shortcuts)) {
        appOwnedEvents.add(view)
        deps.reportAppShortcut?.(event)
        return false
      }
      return deps.isSubmitting?.() ?? false
    }
  }
}

function submittingFilter(deps: EditorKeymapDeps): Extension {
  return EditorState.transactionFilter.of((transaction) =>
    deps.isSubmitting?.() && transaction.docChanged && transaction.annotation(Transaction.userEvent)
      ? []
      : transaction
  )
}

export function editorKeymap(deps: EditorKeymapDeps): Extension {
  const context: KeymapContext = {
    deps,
    appOwnedEvents: new WeakSet(),
    recalls: new WeakMap(),
    composingEvents: new WeakMap()
  }
  return [
    submittingFilter(deps),
    EditorView.updateListener.of((update) => {
      if (update.transactions.some((tr) => tr.docChanged && !tr.annotation(recallChange))) {
        context.recalls.delete(update.view)
      }
    }),
    Prec.highest(
      keymap.of([
        eventBinding(context),
        ...enterBindings(context),
        {
          key: 'Escape',
          run: () => {
            const popup = deps.historyPopup?.()
            if (!popup?.open) return false
            popup.close()
            return true
          }
        },
        ...ctrlBindings(context),
        ...readlineBindings(context),
        { key: 'ArrowUp', run: (view) => recallHandler(context, view, -1) },
        { key: 'ArrowDown', run: (view) => recallHandler(context, view, 1) }
      ])
    )
  ]
}

export function handleTerminalPaste(
  mode: () => InputMode,
  view: EditorView | null,
  text: string,
  write: (data: string) => void | Promise<void>,
  rawText?: string,
  terminalId?: string
): void | Promise<void> {
  const currentMode = mode()
  if (currentMode === 'Editor') {
    if (!view) return
    const clean = sanitizeEditorPaste(rawText ?? text)
    view.dispatch({
      ...view.state.replaceSelection(clean),
      userEvent: 'input.paste',
      scrollIntoView: true
    })
    return
  }
  if (!canTerminalWriteToPty(terminalId, text, currentMode)) return
  return write(text)
}

export function handleTerminalImagePaste(
  mode: () => InputMode,
  _view: EditorView | null,
  write: (data: string) => void | Promise<void>,
  terminalId?: string
): void | Promise<void> {
  const currentMode = mode()
  if (!canTerminalWriteToPty(terminalId, '\x16', currentMode)) return
  return write('\x16')
}
