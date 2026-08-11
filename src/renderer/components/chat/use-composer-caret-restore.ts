import type { Editor } from '@tiptap/core'
import { useCallback, useEffect, useRef } from 'react'
import type { MentionMatch } from '@/components/chat/mention-menu-model'
import type { ComposerMentions } from '@/components/chat/use-composer-mentions'
import { displayOffsetToDocOffset, docOffsetToDisplayOffset } from '@/lib/composer/doc-to-prompt'
import { logFrontendError } from '@/lib/log-api'

/**
 * Schedule a caret restore after a programmatic value splice, with cleanup.
 *
 * The pre-refactor `handleSelect`/`onMentionSelect`/seed paths scheduled caret
 * restoration via a bare `requestAnimationFrame(() => { editor.chain()...run() })`.
 * If the host unmounted (or the editor was destroyed) before the frame fired,
 * the callback ran against a destroyed editor and a surrounding `try/catch`
 * silently swallowed the throw — masking real bugs. This hook owns a single rAF
 * handle per editor instance: it cancels any pending frame before scheduling a
 * new one, cancels on unmount, and no-ops when the editor is gone by the time
 * the frame fires.
 *
 * One hook instance per `ChatComposerEditor` (called in the host), and the
 * returned `scheduleRestoreCaret` is passed into `useChatComposer` so the
 * hook's `handleSelect` + the host's `onMentionSelect`/seed share ONE rAF ref
 * (only the latest restore wins; no double-restore).
 */
export function useComposerCaretRestore(editorRef: React.MutableRefObject<Editor | null>): {
  scheduleRestoreCaret: (displayOffset: number) => void
} {
  const handleRef = useRef<number | null>(null)

  const scheduleRestoreCaret = useCallback(
    (displayOffset: number) => {
      if (handleRef.current != null) {
        cancelAnimationFrame(handleRef.current)
      }
      handleRef.current = requestAnimationFrame(() => {
        handleRef.current = null
        const ed = editorRef.current
        // Editor destroyed/unmounted before the frame fired — safe noop (no
        // throw, no swallowed error).
        if (!ed || ed.isDestroyed) return
        const docPos = displayOffsetToDocOffset(ed.state.doc, displayOffset)
        try {
          ed.chain().focus(undefined, { scrollIntoView: false }).setTextSelection(docPos).run()
        } catch (err) {
          // ProseMirror may reject an out-of-range pos (e.g. the doc re-parsed
          // to a shorter length between schedule + fire). Focus is restored by
          // the `chain().focus()` above; route the edge to the frontend log so
          // it isn't silently swallowed (the bare try/catch before this hook
          // masked real bugs). Not a `console.*` — the project routes renderer
          // warnings through `logFrontendError`.
          void logFrontendError({
            level: 'warn',
            source: 'useComposerCaretRestore',
            message: `setTextSelection failed: ${err instanceof Error ? err.message : String(err)}`
          })
        }
      })
    },
    [editorRef]
  )

  useEffect(() => {
    return () => {
      if (handleRef.current != null) {
        cancelAnimationFrame(handleRef.current)
      }
    }
  }, [])

  return { scheduleRestoreCaret }
}

interface UseComposerMentionSelectOptions {
  value: string
  setValue: (value: string) => void
  editorRef: React.MutableRefObject<Editor | null>
  mentions: Pick<ComposerMentions, 'select' | 'update'>
  scheduleRestoreCaret: (displayOffset: number) => void
}

export function useComposerMentionSelect({
  value,
  setValue,
  editorRef,
  mentions,
  scheduleRestoreCaret
}: UseComposerMentionSelectOptions): (match: MentionMatch) => void {
  return useCallback(
    (match: MentionMatch) => {
      const editor = editorRef.current
      const caret = editor
        ? docOffsetToDisplayOffset(editor.state.doc, editor.state.selection.to)
        : value.length
      const outcome = mentions.select(value, caret, match)
      if (!outcome) return
      setValue(outcome.value)
      mentions.update(outcome.value, outcome.caret)
      scheduleRestoreCaret(outcome.caret)
    },
    [editorRef, mentions, scheduleRestoreCaret, setValue, value]
  )
}
