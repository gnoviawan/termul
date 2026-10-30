import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { type MutableRefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { termulCaretThemeSpec } from '@/components/editor/codemirror-theme'
import { INNER_FIELD_FOCUS_CLASS } from '@/components/ui/panel-styles'
import type { BoundSessionClient } from '@/lib/command-lifecycle/bind-session'
import type { CompletionScheduler } from '@/lib/command-lifecycle/completion'
import { parseCompletionOutput } from '@/lib/command-lifecycle/completion-output'
import { commandDraftStore } from '@/lib/command-lifecycle/draft-store'
import { readEditorRevision } from '@/lib/command-lifecycle/editor-revision'
import { sessionStore } from '@/lib/command-lifecycle/session-store'
import { logFrontendError } from '@/lib/log-api'

import { type CompletionViewSource, completionView, showCompletion } from './completion-view'
import { draftPersistence } from './draft-persistence'
import { type EditorKeymapDeps, editorKeymap, sanitizeEditorPaste } from './editor-keys'
import { type EditorRevisionSnapshot, revisionPlugin } from './revision-plugin'

const defaultKeymapDeps: EditorKeymapDeps = { history: () => [], submit: () => {} }
const defaultCompletionSource: CompletionViewSource = { rows: () => [], request: () => {} }

export const commandEditorChromeTheme = EditorView.theme({
  '&.cm-focused': { outline: 'none' },
  ...termulCaretThemeSpec
})

export interface CommandEditorProps {
  onFocusedUnmount?: () => void
  keymapDeps?: Partial<EditorKeymapDeps>
  completionSource?: CompletionViewSource
  draftStore?: typeof commandDraftStore
  scheduler?: CompletionScheduler
  terminalId: string
  ptyId?: () => string | null
  terminalName?: string
  projectId?: string
  focused: boolean
  viewRef: MutableRefObject<EditorView | null>
}

function buildEditorExtensions(
  terminalId: string,
  draftStore: typeof commandDraftStore,
  depsRef: MutableRefObject<EditorKeymapDeps>,
  completionSourceRef: MutableRefObject<CompletionViewSource>,
  onRevisionRef: MutableRefObject<(snapshot: EditorRevisionSnapshot) => void>
) {
  return [
    commandEditorChromeTheme,
    EditorView.lineWrapping,
    EditorView.clipboardInputFilter.of(sanitizeEditorPaste),
    completionView(
      new Proxy(defaultCompletionSource, {
        get: (_target, key: keyof CompletionViewSource) => completionSourceRef.current[key]
      })
    ),
    editorKeymap(
      new Proxy(defaultKeymapDeps, {
        get: (_target, key: keyof EditorKeymapDeps) => depsRef.current[key]
      })
    ),
    draftPersistence(terminalId, draftStore),
    revisionPlugin(terminalId, (snapshot) => onRevisionRef.current(snapshot)),
    EditorView.contentAttributes.of({
      'aria-label': 'Command editor',
      class: INNER_FIELD_FOCUS_CLASS
    })
  ]
}

function mountEditorView(
  parent: HTMLElement,
  terminalId: string,
  draftStore: typeof commandDraftStore,
  depsRef: MutableRefObject<EditorKeymapDeps>,
  completionSourceRef: MutableRefObject<CompletionViewSource>,
  onRevisionRef: MutableRefObject<(snapshot: EditorRevisionSnapshot) => void>
): EditorView {
  try {
    return new EditorView({
      parent,
      state: EditorState.create({
        doc: draftStore.read(terminalId),
        selection: { anchor: draftStore.read(terminalId).length },
        extensions: buildEditorExtensions(
          terminalId,
          draftStore,
          depsRef,
          completionSourceRef,
          onRevisionRef
        )
      })
    })
  } catch (error) {
    void logFrontendError({ source: 'CommandEditor', message: 'Command editor mount failed' })
    throw error
  }
}

function logEditorLifecycle(message: string) {
  void logFrontendError({ level: 'info', source: 'CommandEditor', message })
}

function readViewSnapshot(view: EditorView, terminalId: string): EditorRevisionSnapshot {
  return {
    draft: view.state.doc.toString(),
    cursor: view.state.selection.main.head,
    revision: readEditorRevision(terminalId)
  }
}

function useEditorViewLifecycle(
  containerRef: MutableRefObject<HTMLDivElement | null>,
  viewRef: MutableRefObject<EditorView | null>,
  terminalId: string,
  draftStore: typeof commandDraftStore,
  depsRef: MutableRefObject<EditorKeymapDeps>,
  completionSourceRef: MutableRefObject<CompletionViewSource>,
  onRevisionRef: MutableRefObject<(snapshot: EditorRevisionSnapshot) => void>,
  unmountRef: MutableRefObject<CommandEditorProps['onFocusedUnmount']>
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs from useRef are stable; preserve editor rebuild dependencies.
  useLayoutEffect(() => {
    if (!containerRef.current) return
    const view = mountEditorView(
      containerRef.current,
      terminalId,
      draftStore,
      depsRef,
      completionSourceRef,
      onRevisionRef
    )
    viewRef.current = view
    onRevisionRef.current(readViewSnapshot(view, terminalId))
    logEditorLifecycle('Command editor mounted')
    return () => {
      if (view.dom.contains(document.activeElement)) unmountRef.current?.()
      viewRef.current = null
      view.destroy()
      logEditorLifecycle('Command editor unmounted')
    }
  }, [terminalId, draftStore, viewRef])
}

function useEditorCompletion(
  terminalId: string,
  binder: BoundSessionClient,
  viewRef: MutableRefObject<EditorView | null>
) {
  const snapshot = useRef<EditorRevisionSnapshot>({
    draft: '',
    cursor: 0,
    revision: readEditorRevision(terminalId)
  })
  useLayoutEffect(
    () =>
      binder.subscribeCompletion(() => {
        if (viewRef.current) showCompletion(viewRef.current)
      }),
    [binder, viewRef]
  )
  const source: CompletionViewSource = {
    rows: () => {
      const result = binder.completion()
      const current = snapshot.current
      if (
        !result ||
        result.buffer_revision !== current.revision ||
        result.cursor !== current.cursor
      )
        return []
      return parseCompletionOutput(current.draft, current.cursor, result.output)
    },
    request: () => {
      const view = viewRef.current
      if (!view) return
      snapshot.current = readViewSnapshot(view, terminalId)
      binder.requestCompletion(snapshot.current)
    }
  }
  return {
    source,
    onRevision: (next: EditorRevisionSnapshot) => {
      snapshot.current = next
      binder.updateContext(next)
    }
  }
}

function useEditorFocus(
  focused: boolean,
  viewRef: MutableRefObject<EditorView | null>,
  terminalId: string
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: terminalId rebuilds the view in the preceding effect.
  useEffect(() => {
    if (focused) viewRef.current?.focus()
  }, [focused, viewRef, terminalId])
}

export function useCommandEditorView({
  terminalId,
  focused,
  viewRef,
  onFocusedUnmount,
  binder,
  keymapDeps = {},
  completionSource,
  draftStore = commandDraftStore
}: CommandEditorProps & { binder: BoundSessionClient }) {
  const completion = useEditorCompletion(terminalId, binder, viewRef)
  const unmountRef = useRef(onFocusedUnmount)
  unmountRef.current = onFocusedUnmount
  const boundKeymap: EditorKeymapDeps = {
    history: () => [],
    isSubmitting: () => sessionStore.read(terminalId).phase === 'Submitting',
    ...keymapDeps,
    submit: keymapDeps.submit ?? ((text) => void binder.submit(text))
  }
  const depsRef = useRef(boundKeymap)
  depsRef.current = boundKeymap
  const completionSourceRef = useRef(completionSource ?? completion.source)
  completionSourceRef.current = completionSource ?? completion.source
  const onRevisionRef = useRef(completion.onRevision)
  onRevisionRef.current = completion.onRevision
  const containerRef = useRef<HTMLDivElement>(null)

  useEditorViewLifecycle(
    containerRef,
    viewRef,
    terminalId,
    draftStore,
    depsRef,
    completionSourceRef,
    onRevisionRef,
    unmountRef
  )

  useEditorFocus(focused, viewRef, terminalId)

  return containerRef
}
