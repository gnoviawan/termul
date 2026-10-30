import type { EditorView } from '@codemirror/view'
import { type ReactNode, type RefObject, type SyntheticEvent, useRef } from 'react'
import { commandDraftStore } from '@/lib/command-lifecycle/draft-store'
import { canWriteToPty } from '@/lib/command-lifecycle/input-guard'
import { sessionStore } from '@/lib/command-lifecycle/session-store'
import type { InputMode } from '@/lib/command-lifecycle/transition'
import { CommandEditor } from './CommandEditor'
import { CommandChips } from './chips'
import type { EditorKeymapDeps } from './editor-keys'
import { useTerminalEditorKeymap } from './use-terminal-editor-keymap'

interface TerminalInputSurfaceProps {
  focusTerminal?: () => void
  keymapDeps?: Partial<EditorKeymapDeps>
  viewRef?: RefObject<EditorView | null>
  draftStore?: typeof commandDraftStore
  allowWrite?: boolean
  cwd?: string
  gitBranch?: string
  mode: InputMode
  focused: boolean
  terminalId: string
  ptyId?: () => string | null
  terminalName?: string
  projectId?: string
  children: ReactNode
}

function useFocusReturn(
  mode: InputMode,
  allowWrite: boolean,
  focused: boolean,
  viewRef: RefObject<EditorView | null>,
  focusTerminal?: () => void
) {
  const latest = useRef({ mode, allowWrite, focused, viewRef, focusTerminal })
  latest.current = { mode, allowWrite, focused, viewRef, focusTerminal }
  return () => {
    if (!latest.current.focused) return
    if (
      latest.current.mode === 'Editor' &&
      latest.current.allowWrite &&
      latest.current.viewRef.current
    ) {
      latest.current.viewRef.current.focus()
      return
    }
    if (latest.current.mode !== 'Editor') latest.current.focusTerminal?.()
  }
}

function isCtrlCKeyDown(event: SyntheticEvent): boolean {
  if (event.type !== 'keydown') return false
  const native = event.nativeEvent as KeyboardEvent
  return (
    native.ctrlKey &&
    !native.metaKey &&
    !native.altKey &&
    !native.shiftKey &&
    (native.key === 'c' || native.key === 'C' || native.key === '\x03')
  )
}

function discardSubmittingInput(terminalId: string, event: SyntheticEvent): void {
  const session = sessionStore.read(terminalId)
  if (session.phase !== 'Submitting' || !session.trusted || !session.alive) return
  if (canWriteToPty(session, isCtrlCKeyDown(event) ? '\x03' : '')) return
  event.preventDefault()
  event.stopPropagation()
}

function EditorSurface({
  props,
  viewRef,
  onFocusedUnmount
}: {
  props: TerminalInputSurfaceProps
  viewRef: RefObject<EditorView | null>
  onFocusedUnmount: () => void
}) {
  return (
    <div
      data-slot="command-editor-block"
      className="flex shrink-0 flex-col gap-1 border-t border-border bg-card pt-2"
    >
      <CommandChips cwd={props.cwd} gitBranch={props.gitBranch} />
      <CommandEditor
        onFocusedUnmount={onFocusedUnmount}
        keymapDeps={props.keymapDeps}
        terminalId={props.terminalId}
        ptyId={props.ptyId}
        terminalName={props.terminalName}
        projectId={props.projectId}
        focused={props.focused}
        viewRef={viewRef}
        draftStore={props.draftStore ?? commandDraftStore}
      />
    </div>
  )
}

export function TerminalInputSurface(props: TerminalInputSurfaceProps) {
  const { mode, focused, focusTerminal, allowWrite = true, terminalId } = props
  const localViewRef = useRef<EditorView | null>(null)
  const viewRef = props.viewRef ?? localViewRef
  const keymapDeps = useTerminalEditorKeymap({ ...props, allowWrite, viewRef })
  const onFocusedUnmount = useFocusReturn(mode, allowWrite, focused, viewRef, focusTerminal)
  const editing = mode === 'Editor' && allowWrite
  const discard = (event: SyntheticEvent) => discardSubmittingInput(terminalId, event)
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      data-focused={focused}
      onKeyDownCapture={discard}
      onPasteCapture={discard}
      onInputCapture={discard}
    >
      <section
        aria-label="Terminal scrollback"
        className="min-h-0 flex-1"
        data-keyboard-target={!editing}
        tabIndex={editing ? -1 : undefined}
        onFocus={editing ? () => viewRef.current?.focus() : undefined}
      >
        {props.children}
      </section>
      {editing && (
        <EditorSurface
          props={{ ...props, keymapDeps }}
          viewRef={viewRef}
          onFocusedUnmount={onFocusedUnmount}
        />
      )}
    </div>
  )
}
