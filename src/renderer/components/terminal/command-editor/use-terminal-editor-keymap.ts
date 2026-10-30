import type { EditorView } from '@codemirror/view'
import type { RefObject } from 'react'
import { clipboardApi, terminalApi } from '@/lib/api'
import { canTerminalWriteToPty } from '@/lib/command-lifecycle/input-guard'
import { sessionStore } from '@/lib/command-lifecycle/session-store'
import { logFrontendError } from '@/lib/log-api'
import { useCommandHistoryStore } from '@/stores/command-history-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import type { EditorKeymapDeps } from './editor-keys'

interface TerminalEditorKeymapOptions {
  terminalId: string
  projectId?: string
  ptyId?: () => string | null
  allowWrite?: boolean
  viewRef: RefObject<EditorView | null>
  keymapDeps?: Partial<EditorKeymapDeps>
}

function reportKeymap(message: string, level: 'info' | 'warn' = 'info') {
  void logFrontendError({ source: 'TerminalEditorKeymap', message, level })
}

function copySelection(text: string) {
  if (!text || text.length > 10 * 1024 * 1024) return
  void clipboardApi.writeText(text).then(
    (result) => {
      if (!result.success) reportKeymap('Copy selection failed', 'warn')
    },
    () => reportKeymap('Copy selection failed', 'warn')
  )
}

function writePty(options: TerminalEditorKeymapOptions, text: string) {
  const ptyId = options.ptyId?.()
  if (!options.allowWrite || !ptyId || !canTerminalWriteToPty(options.terminalId, text)) return
  void terminalApi.write(ptyId, text).then(
    (result) => {
      if (!result.success) reportKeymap('PTY write failed', 'warn')
    },
    () => reportKeymap('PTY write failed', 'warn')
  )
}

export function useTerminalEditorKeymap(
  options: TerminalEditorKeymapOptions
): Partial<EditorKeymapDeps> {
  const { terminalId, projectId, viewRef } = options
  return {
    isSubmitting: () => sessionStore.read(terminalId).phase === 'Submitting',
    composition: () => ({
      open: !!(viewRef.current?.composing || viewRef.current?.compositionStarted),
      text: ''
    }),
    history: () =>
      useCommandHistoryStore
        .getState()
        .entries.filter((entry) => !!projectId && entry.projectId === projectId)
        .map((entry) => entry.command)
        .reverse(),
    selection: () => '',
    copy: copySelection,
    leave: () => {
      if (!options.allowWrite) return
      sessionStore.leaveEditor(terminalId)
    },
    sendEof: () => writePty(options, '\x04'),
    writePty: (text) => writePty(options, text),
    shortcuts: () => useKeyboardShortcutsStore.getState().shortcuts,
    // Like xterm, leave the original event bubbling to useWorkspaceKeyboard.
    reportAppShortcut: () => reportKeymap('App shortcut passed to workspace'),
    // T7/T11 supply the contract only; no production history popup exists.
    historyPopup: undefined,
    ...options.keymapDeps
  }
}
