import { type Editor, type EditorEvents, Extension } from '@tiptap/core'
import { Placeholder } from '@tiptap/extension-placeholder'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef } from 'react'
import {
  docOffsetToDisplayOffset,
  docToDisplayText,
  SKILL_PILL_NODE
} from '@/lib/composer/doc-to-prompt'
import { draftFromTokens } from '@/lib/composer/draft-from-tokens'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { SkillPill } from './SkillPillNode'

export interface ChatComposerEditorProps {
  /**
   * The display string carrying sentinel skill tokens — the single source of
   * truth shared with `useChatComposer.buildPromptParts` and per-session draft
   * persistence. The editor parses it into a doc (pills become inline nodes);
   * every editor transaction re-serializes the doc back to this string via
   * {@link onValueChange}.
   */
  value: string
  onValueChange: (value: string) => void
  /** Live caret sync: `(displayValue, displayCaret)` after every transaction.
   * Feeds `useComposerMentions.update` so the @-mention menu tracks the caret. */
  onCaretChange?: (value: string, caret: number) => void
  /**
   * High-priority keydown hook running BEFORE the editor's own keymap. Return
   * `true` to consume (the editor skips its default handling for that key).
   * Hosts route slash-menu + mention-menu + Enter→submit / Escape→cancel
   * (surface-specific) through this callback. Backspace-pill removal is owned
   * by the editor itself (it is an editor-native concern).
   */
  onBeforeEditorKeyDown?: (event: KeyboardEvent) => boolean | undefined
  /** Ref that receives the editor instance once it mounts (for `useChatComposer`
   * to drive transactional skill insertion + caret restoration). */
  editorRef?: React.MutableRefObject<Editor | null>
  /**
   * Attachment paste hook: called first on every paste. If it calls
   * `event.preventDefault()` (an attachment was staged), the editor consumes
   * the paste and does NOT insert text/pills. Used by `useComposerAttachments`
   * to stage pasted images/files. Falls through to sentinel-token parsing +
   * ProseMirror default when not consumed. The event is the editor's raw DOM
   * `ClipboardEvent`; the host adapter exposes `currentTarget`/`nativeEvent`.
   */
  onPasteAttachments?: (event: ClipboardEvent) => void
  /**
   * Optional name→SKILL.md path map getter (from `useChatComposer.skillPathsRef`).
   * Used by `handlePaste` to seed pasted pill nodes' `path` attrs so a pasted
   * token naming a known skill resolves at send. Unknown skills keep `path:''`
   * and hit the existing missing-path toast (graceful).
   */
  getSkillPaths?: () => Record<string, string>
  disabled?: boolean
  placeholder?: string
  ariaLabel?: string
  autoFocus?: boolean
  /** Min/max heights (CSS px). The editor grows with content up to `maxHeight`,
   * then scrolls — replaces the old textarea `clampHeight`/`resetHeight`. */
  minHeight?: number
  maxHeight?: number
  className?: string
  editorClassName?: string
}

const KEYMAP_KEY = new PluginKey('chatComposerKeymap')

/**
 * Factory: build a per-instance keymap extension that closes over a stable ref
 * to the host's `onBeforeEditorKeyDown` callback. The ref is created per
 * `ChatComposerEditor` instance (`useRef`) and reassigned on every render, so
 * each editor instance reads its OWN host's callback — two co-mounted editors
 * (ChatInputBar + AgentLauncher) no longer share a module-level ref, and Enter/
 * Escape in one host cannot route to the other host's submit/launch.
 *
 * The editor instance is created once (`useEditor(..., [])` deps); the factory
 * is invoked once at editor-creation time, capturing the stable ref object. The
 * ref's `.current` is reassigned every render by the component body, so the
 * plugin always reads the latest callback WITHOUT recreating the editor
 * (preserving caret + history across re-renders).
 */
function createComposerKeymap(
  beforeKeyDownRef: React.MutableRefObject<((event: KeyboardEvent) => boolean | undefined) | null>
): Extension {
  return Extension.create({
    name: 'chatComposerKeymap',
    priority: 1000,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: KEYMAP_KEY,
          props: {
            handleKeyDown: (view, event) => {
              // 1) Host-owned keys (slash/mention menu, Enter→submit, Escape).
              if (beforeKeyDownRef.current?.(event as KeyboardEvent) === true) {
                return true
              }
              // 2) Backspace-over-pill removal (editor-native). Only when the
              // selection is empty and the inline node immediately before the
              // caret is an atom skillPill. Alt/meta/ctrl/shift excluded so macOS
              // Option+Backspace (delete-word) doesn't slice a pill and leave
              // orphan sentinels (mirrors the pre-refactor guard).
              if (
                event instanceof KeyboardEvent &&
                event.key === 'Backspace' &&
                !event.shiftKey &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey
              ) {
                const { state } = view
                const { selection } = state
                if (selection.empty) {
                  // The splicer appends a trailing space after the pill so the
                  // caret lands in plain text. Tolerate that: when the immediate
                  // node before the caret is a single-space text node, step back
                  // one position to reach the pill (mirrors the pre-refactor
                  // `removeSkillTokenBeforeCaret` trailing-space walk).
                  const caret = selection.from
                  let probePos = caret
                  let before = selection.$from.nodeBefore
                  if (before?.isText && before.text === ' ') {
                    const $prev = state.doc.resolve(Math.max(0, probePos - 1))
                    const prevNode = $prev.nodeBefore
                    if (prevNode && prevNode.type.name === SKILL_PILL_NODE) {
                      before = prevNode
                      probePos = probePos - 1
                    }
                  }
                  if (before && before.type.name === SKILL_PILL_NODE) {
                    event.preventDefault()
                    // Delete the pill + any trailing space the splicer appended
                    // (the caret sat after the space) — matches the pre-refactor
                    // `removeSkillTokenBeforeCaret` whole-token + trailing-space
                    // removal.
                    const from = probePos - before.nodeSize
                    const to = caret
                    const tr = state.tr.delete(from, to)
                    // Land the caret at the pre-pill offset (end of preceding
                    // text, or start of block if the pill was first).
                    const $p = tr.doc.resolve(Math.max(0, from))
                    try {
                      tr.setSelection(TextSelection.near($p, -1))
                    } catch {
                      tr.setSelection(TextSelection.near($p))
                    }
                    view.dispatch(tr)
                    return true
                  }
                }
              }
              return false
            }
          }
        })
      ]
    }
  })
}

/**
 * Tiptap rich-text editor wrapper for the modular chat composer. Replaces the
 * transparent-`<textarea>` + `SkillComposerOverlay` surface: the skill "pill"
 * is now a real inline DOM node (a Tiptap `NodeView`), so the caret sits flush
 * against the pill's right edge by construction — no canvas-based figure-space
 * padding, no `Math.round` residual, no overlay scroll-sync. The editor's doc
 * is the visible surface; the sentinel-token **display string** (this
 * component's `value`/`onValueChange`) is the shared model the rest of the
 * pipeline (wire builder, draft persistence, timeline) consumes, so the wire
 * payload stays byte-identical to the pre-refactor surface.
 *
 * Per-instance keymap ref: `beforeKeyDownRef` is a `useRef` (NOT module scope),
 * so two co-mounted editors each read their own host's `onBeforeEditorKeyDown`.
 */
export function ChatComposerEditor({
  value,
  onValueChange,
  onCaretChange,
  onBeforeEditorKeyDown,
  onPasteAttachments,
  getSkillPaths,
  editorRef,
  disabled = false,
  placeholder,
  ariaLabel,
  autoFocus = false,
  minHeight = 52,
  maxHeight = 160,
  className,
  editorClassName
}: ChatComposerEditorProps): React.JSX.Element {
  const onValueChangeRef = useRef(onValueChange)
  const onCaretChangeRef = useRef(onCaretChange)
  const onPasteAttachmentsRef = useRef(onPasteAttachments)
  const getSkillPathsRef = useRef(getSkillPaths)
  onValueChangeRef.current = onValueChange
  onCaretChangeRef.current = onCaretChange
  onPasteAttachmentsRef.current = onPasteAttachments
  getSkillPathsRef.current = getSkillPaths

  // Per-instance ref holding the latest `onBeforeEditorKeyDown`. Reassigned
  // every render (refs are mutable, no effect needed); the keymap plugin reads
  // it at keydown time. Per-instance → no cross-talk between co-mounted editors.
  const beforeKeyDownRef = useRef<((event: KeyboardEvent) => boolean | undefined) | null>(null)
  beforeKeyDownRef.current = onBeforeEditorKeyDown ?? null

  const lastEmittedRef = useRef<string>(value)
  const lastCaretRef = useRef<number>(-1)
  // Suppresses onTransaction re-emit during a programmatic setContent so an
  // external value change doesn't echo back into setValue (React dedupes it,
  // but skipping the call keeps the effect chain clean). Always reset in a
  // `finally` so a malformed draft throwing inside setContent cannot leave it
  // stuck `true` and permanently swallow emits.
  const silentRef = useRef(false)

  const editor = useEditor(
    {
      content: draftFromTokens(value),
      // ComposerKeymap is listed BEFORE StarterKit so its `handleKeyDown` runs
      // first (host-owned Enter→submit / Escape + Backspace-pill removal must
      // beat StarterKit's Enter/splitBlock + base Backspace). `priority: 1000`
      // also orders the plugin earlier in the chain, but array order is the
      // load-bearing guarantee.
      extensions: [
        SkillPill,
        createComposerKeymap(beforeKeyDownRef),
        Placeholder.configure({
          placeholder: placeholder ?? '',
          showOnlyWhenEditable: true
        }),
        StarterKit.configure({
          blockquote: false,
          bulletList: false,
          codeBlock: false,
          code: false,
          heading: false,
          horizontalRule: false,
          bold: false,
          italic: false,
          strike: false,
          listItem: false,
          orderedList: false
        })
      ],
      editorProps: {
        attributes: {
          'aria-multiline': 'true',
          role: 'textbox',
          'data-composer-editor': 'true',
          // Mobile OSK affordances (Story 5.3): `inputMode=text` + `enterKeyHint=send`
          // so iOS Safari shows the send key affordance on the on-screen keyboard.
          inputmode: 'text',
          enterkeyhint: 'send',
          ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
          class: cn(
            // text-base (16px): floor for iOS Safari — sub-16px inputs zoom on focus.
            'text-base leading-relaxed outline-none',
            'placeholder:text-muted-foreground',
            'disabled:cursor-not-allowed disabled:text-muted-foreground',
            editorClassName
          )
        },
        handlePaste: (view, event) => {
          // 1) Attachment paste (images/files). If the attachment handler
          // consumes it (preventDefault), the editor skips text/pill insertion.
          onPasteAttachmentsRef.current?.(event as ClipboardEvent)
          if (event.defaultPrevented) return true
          const text = event.clipboardData?.getData('text/plain') ?? ''
          // 2) ONLY parse pill nodes from the `\uE000` sentinel in `text/plain`.
          // Never parse pills from HTML (SkillPill.parseHTML returns []), so a
          // malicious clipboard carrying `<span data-skill-pill>` cannot inject
          // pill nodes. Plain-text paste (no sentinel) falls through to
          // ProseMirror's default (text nodes).
          if (!text.includes('\uE000')) return false
          event.preventDefault()
          try {
            const parsed = view.state.schema.nodeFromJSON(
              draftFromTokens(text, getSkillPathsRef.current?.() ?? {})
            )
            const slice = parsed.slice(0)
            const tr = view.state.tr.replaceSelection(slice)
            tr.setMeta('paste', true)
            view.dispatch(tr)
            return true
          } catch (err) {
            // Malformed clipboard — degrade to plain-text paste (let
            // ProseMirror's default handle it).
            void logFrontendError({
              level: 'warn',
              source: 'ChatComposerEditor.handlePaste',
              message: `sentinel clipboard parse failed, falling back to plain-text: ${
                err instanceof Error ? err.message : String(err)
              }`
            })
            return false
          }
        }
      },
      onTransaction: ({ editor }: EditorEvents['transaction']) => {
        if (silentRef.current) return
        const text = docToDisplayText(editor.state.doc)
        if (text !== lastEmittedRef.current) {
          lastEmittedRef.current = text
          onValueChangeRef.current(text)
        }
        const caret = docOffsetToDisplayOffset(editor.state.doc, editor.state.selection.to)
        if (caret !== lastCaretRef.current) {
          lastCaretRef.current = caret
          onCaretChangeRef.current?.(text, caret)
        }
      },
      editable: !disabled,
      // Disable Tiptap's `autofocus` option here: it defers focus via a raw
      // `window.setTimeout(0)` (see `@tiptap/core` `init`) that React `act`
      // cannot flush in tests — it fires after the test's first interaction,
      // stealing focus from a Radix Popover that just opened its search input
      // (closes it via `onFocusOutside`). Mount-time focus is done synchronously
      // in the effect below (flushed by `act` before any interaction), mirroring
      // the pre-refactor `<textarea autoFocus>`.
      autofocus: false
    },
    []
  )

  // Synchronous mount-time focus (replaces Tiptap's `autofocus` option above).
  // `editor.view.focus()` is synchronous (ProseMirror), so — unlike Tiptap's
  // `setTimeout(0)` autofocus — it establishes focus inside the `act`-flushed
  // effect phase, before the test's first popover click. Non-critical on error.
  useEffect(() => {
    if (!autoFocus || !editor || editor.isDestroyed) return
    try {
      editor.view.focus()
    } catch {
      // Editor not ready / focus not allowed — non-critical, ignore.
    }
  }, [editor, autoFocus])

  // Live placeholder: `useEditor(..., [])` bakes `Placeholder.configure({ placeholder })`
  // at mount, so the dynamic placeholder (switches on `disabled`/`activeCommand`)
  // never reaches the running editor. Update the extension's option storage +
  // dispatch an empty transaction to re-decorate so the new placeholder paints.
  useEffect(() => {
    if (!editor) return
    const storage = editor.extensionStorage.placeholder as
      | { options: { placeholder?: string } }
      | undefined
    if (storage?.options) {
      storage.options.placeholder = placeholder ?? ''
    }
    // Empty transaction triggers Placeholder's decoration recompute.
    try {
      editor.view.dispatch(editor.state.tr)
    } catch {
      // Editor being destroyed — ignore.
    }
  }, [editor, placeholder])

  // Expose the editor instance to the host (and to `useChatComposer`).
  useEffect(() => {
    if (!editorRef) return
    editorRef.current = editor
    return () => {
      if (editorRef.current === editor) editorRef.current = null
    }
  }, [editor, editorRef])

  // Expose a test/debug handle on the DOM element so tests can drive the
  // editor imperatively. Gated by `import.meta.env.MODE === 'test'` so the
  // full editor instance (commands, state, schema) is NOT exposed to page
  // scripts in production.
  useEffect(() => {
    if (!editor) return
    if (import.meta.env.MODE !== 'test') return
    const dom = editor.view.dom as HTMLElement & { __composerEditor?: Editor | null }
    dom.__composerEditor = editor
    return () => {
      if (dom.__composerEditor === editor) dom.__composerEditor = null
    }
  }, [editor])

  // External value sync: when `value` changes and does not equal the last
  // string the editor emitted, re-parse the doc silently. The caret snaps to
  // the end for plain clears (send/clear); for splices the host restores the
  // caret via `editorRef.current.chain().setTextSelection(...)` in a rAF.
  // `silentRef` is reset in a `finally` so a malformed draft throwing inside
  // `draftFromTokens`/`setContent` cannot leave it stuck `true` and permanently
  // swallow all future `onTransaction` emits (which would desync the editor
  // from `value`).
  useEffect(() => {
    if (!editor) return
    if (value === lastEmittedRef.current) return
    silentRef.current = true
    try {
      editor.commands.setContent(draftFromTokens(value), false)
    } catch (err) {
      // A malformed draft (corrupted persisted value) should never permanently
      // break the editor — log + fall back to an empty doc so the user can keep
      // typing. The on-disk draft is preserved (we don't overwrite value here).
      void logFrontendError({
        level: 'warn',
        source: 'ChatComposerEditor.rehydrateValue',
        message: `malformed draft re-parse failed, falling back to empty doc: ${
          err instanceof Error ? err.message : String(err)
        }`
      })
      try {
        editor.commands.setContent(draftFromTokens(''), false)
      } catch {
        // Last-resort: leave the editor as-is.
      }
    } finally {
      silentRef.current = false
    }
    lastEmittedRef.current = value
    const caret = docOffsetToDisplayOffset(editor.state.doc, editor.state.selection.to)
    lastCaretRef.current = caret
  }, [value, editor])

  // Disabled toggle.
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!disabled)
  }, [editor, disabled])

  return (
    <div
      className={cn('relative w-full overflow-hidden', disabled && 'opacity-60', className)}
      style={{ minHeight: `${minHeight}px`, maxHeight: `${maxHeight}px` }}
    >
      <div className="h-full w-full overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
