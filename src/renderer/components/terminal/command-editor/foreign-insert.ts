import { cursorCharLeft, cursorCharRight } from '@codemirror/commands'
import { type EditorView, runScopeHandlers } from '@codemirror/view'
import { commandDraftStore } from '@/lib/command-lifecycle/draft-store'
import { canTerminalWriteToPty } from '@/lib/command-lifecycle/input-guard'
import type { InputMode } from '@/lib/command-lifecycle/transition'
import { logFrontendError } from '@/lib/log-api'
import { handleTerminalPaste } from './editor-keys'

export interface EditorInputTarget {
  ptyId: () => string | null
  mode: () => InputMode
  view: () => EditorView | null
  terminalId: string
  allowWrite: () => boolean
  scrollPages: (pages: number) => void
}

const targets = new Set<EditorInputTarget>()

export function registerEditorInputTarget(target: EditorInputTarget): () => void {
  targets.add(target)
  return () => {
    targets.delete(target)
  }
}

export function findEditorInputTarget(ptyId: string): EditorInputTarget | undefined {
  return Array.from(targets).find(
    (target) => target.ptyId() === ptyId || target.terminalId === ptyId
  )
}

export function routeForeignInsert(
  target: EditorInputTarget,
  kind: 'assist' | 'history',
  text: string,
  write: (text: string) => void | Promise<void>,
  onError?: (message: string) => void
): void | Promise<void> {
  if (!target.allowWrite()) return
  const mode = target.mode()
  if ((mode === 'Editor' || kind === 'assist') && containsControlCharacter(text)) {
    const message = 'Refused to insert a command containing control characters'
    void logFrontendError({ level: 'warn', source: 'foreign-insert', message })
    onError?.(message)
    return
  }
  if (mode === 'Editor') {
    void logFrontendError({
      level: 'info',
      source: 'foreign-insert',
      message: 'Foreign insert routed to editor'
    })
    const view = target.view()
    if (view) {
      view.dispatch({
        ...(kind === 'assist'
          ? view.state.replaceSelection(text)
          : {
              changes: { from: 0, to: view.state.doc.length, insert: text },
              selection: { anchor: text.length }
            }),
        userEvent: 'input.insert'
      })
    } else {
      commandDraftStore.offer(
        target.terminalId,
        'Editor',
        kind === 'assist' ? commandDraftStore.read(target.terminalId) + text : text
      )
    }
    return
  }
  if (!canTerminalWriteToPty(target.terminalId, text, mode)) return
  return write(text)
}

const mobileKeys: Record<string, KeyboardEventInit> = {
  '\x1b': { key: 'Escape' },
  '\t': { key: 'Tab' },
  '\x03': { key: 'c', ctrlKey: true },
  '\x1b[D': { key: 'ArrowLeft' },
  '\x1b[C': { key: 'ArrowRight' },
  '\x1b[A': { key: 'ArrowUp' },
  '\x1b[B': { key: 'ArrowDown' }
}

const mobilePageKeys: Record<string, number> = {
  '\x1b[5~': -1,
  '\x1b[6~': 1
}

export function routeMobileKey(
  target: EditorInputTarget,
  kind: 'key' | 'paste',
  text: string,
  write: (text: string) => void | Promise<void>
): void | Promise<void> {
  if (!target.allowWrite()) return
  const mode = target.mode()
  if (mode !== 'Editor') {
    if (!canTerminalWriteToPty(target.terminalId, text, mode)) return
    return write(text)
  }
  const pages = kind === 'key' ? mobilePageKeys[text] : undefined
  if (pages !== undefined) {
    target.scrollPages(pages)
    return
  }
  const view = target.view()
  if (!view) return
  void logFrontendError({
    level: 'info',
    source: 'foreign-insert',
    message: 'Mobile input routed to editor'
  })
  if (kind === 'paste') {
    return handleTerminalPaste(target.mode, view, text, write, undefined, target.terminalId)
  }
  const init = mobileKeys[text]
  if (!init) return
  const event = new KeyboardEvent('keydown', init)
  if (runScopeHandlers(view, event, 'editor')) return
  if (event.key === 'ArrowLeft') cursorCharLeft(view)
  if (event.key === 'ArrowRight') cursorCharRight(view)
}

function containsControlCharacter(text: string): boolean {
  return Array.from(text).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
}
