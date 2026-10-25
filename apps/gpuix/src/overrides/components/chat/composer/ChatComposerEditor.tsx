/**
 * GPUIX twin of `components/chat/composer/ChatComposerEditor.tsx`.
 *
 * tiptap needs contentEditable, and stock GPUIX 0.11 has IME only inside
 * `<textarea>`. So the draft is edited in a native textarea that shows each
 * pill as a label (`@file`, `/command`), while `src/composer/model.ts` keeps
 * the real document and the pill ranges. Each native edit is diffed back onto
 * the document (`reconcile`), which deletes a pill as a unit and writes the
 * corrected text back when an edit cut into a label.
 *
 * The textarea swallows Backspace, the arrows and Enter as native actions,
 * and they never reach `onKeyDown`. A menu needs ↑/↓/Enter, so while a
 * composer menu is open (it sets `aria-controls` on `inputRef`) keyboard focus
 * moves to a key-capture box: the host's `onBeforeEditorKeyDown` sees every key
 * first, and unhandled keys edit the document directly. When the menu closes,
 * focus returns to the textarea at the document's caret.
 */

import { flushSync, type KeyEvent, type PublicInstance, useGpuixRequired } from '@gpuix/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { compatTw } from '../../../../compat/translate'
import {
  asHostElement,
  ComposerInputElement,
  composerKeyEvent,
  type KeyInit,
  keyInitFrom
} from '../../../../composer/dom-bridge'
import {
  type ComposerDoc,
  deleteBackward,
  deleteForward,
  type EditResult,
  fromDisplay,
  fromDisplayOffset,
  insertText,
  moveCaret,
  project,
  toDisplay,
  toDisplayOffset
} from '../../../../composer/model'
import { type NativeComposerEditor, placeTextareaCaret } from '../../../../composer/native-editor'
import { reconcile } from '../../../../composer/reconcile'
import type { ComposerEditor } from './editor-ops'

export interface ChatComposerEditorProps {
  value: string
  onValueChange: (value: string) => void
  onCaretChange?: (value: string, caret: number) => void
  onBeforeEditorKeyDown?: (event: KeyboardEvent) => boolean | undefined
  editorRef?: React.MutableRefObject<ComposerEditor | null>
  inputRef?: React.MutableRefObject<HTMLElement | null>
  onPasteAttachments?: (event: ClipboardEvent) => void
  getSkillPaths?: () => Record<string, string>
  disabled?: boolean
  placeholder?: string
  ariaLabel?: string
  autoFocus?: boolean
  minHeight?: number
  maxHeight?: number
  className?: string
  editorClassName?: string
}

/** A new `value` reaches the native editor on its next GPUI frame; the caret walk must come after it. */
const CARET_SYNC_MS = 40
const LOG_SOURCE = 'ChatComposerEditor.gpuix'

const CAPTURE_STYLE = { position: 'absolute', left: 0, top: 0, width: 1, height: 1 } as const
const PROBE_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: 0,
  height: 0,
  overflow: 'hidden'
} as const
/**
 * GPUIX emits focus and blur only for an element with its own listener. With
 * one, the root bubbles the composer's focus to the wrapper's `focus-within:`
 * (compat `bubbleNativeFocus`), so the focus border paints as on the web.
 */
const TRACK_FOCUS = { onFocus: () => {}, onBlur: () => {} }

/**
 * Set by the composer scene, or by TERMUL_GPUIX_TEST_HOOKS=1 for the whole app:
 * the automation tree does not carry a textarea's value, so the editor mirrors
 * its state into an unpainted text node, as the web editor exposes itself on
 * its DOM node in test mode.
 */
function testHooksEnabled(): boolean {
  const scope = globalThis as {
    __TERMUL_GPUIX_TEST_HOOKS__?: boolean
    process?: { env: Record<string, string | undefined> }
  }
  return (
    scope.__TERMUL_GPUIX_TEST_HOOKS__ === true || scope.process?.env.TERMUL_GPUIX_TEST_HOOKS === '1'
  )
}

function isPrintable(init: KeyInit): boolean {
  return init.key.length === 1 && !init.ctrlKey && !init.metaKey && !init.altKey
}

export function ChatComposerEditor(props: ChatComposerEditorProps): React.JSX.Element {
  const {
    value,
    disabled = false,
    placeholder,
    ariaLabel,
    autoFocus = false,
    minHeight = 26,
    maxHeight = 160,
    className,
    editorClassName
  } = props
  const renderer = useGpuixRequired()
  const propsRef = useRef(props)
  propsRef.current = props

  const docRef = useRef<ComposerDoc>(fromDisplay(value))
  const [text, setText] = useState(() => project(docRef.current).text)
  /** What the native textarea holds, as far as its last change and our last write say. */
  const nativeRef = useRef(text)
  const caretRef = useRef(text.length)
  const lastEmittedRef = useRef(value)
  const lastCaretRef = useRef(-1)
  const textareaIdRef = useRef<number | null>(null)
  const captureIdRef = useRef<number | null>(null)
  const inputElementRef = useRef<ComposerInputElement | null>(null)
  const placeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveRef = useRef(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuOpenRef = useRef(false)
  menuOpenRef.current = menuOpen

  const emit = useCallback((doc: ComposerDoc, caret: number) => {
    const display = toDisplay(doc)
    if (display !== lastEmittedRef.current) {
      lastEmittedRef.current = display
      // GPUIX can deliver a frame's change and submit events in one task; the
      // host's Enter handler must already see this value, as it does after a
      // ProseMirror transaction on the web.
      flushSync(() => propsRef.current.onValueChange(display))
    }
    const displayCaret = toDisplayOffset(doc, caret)
    if (displayCaret !== lastCaretRef.current) {
      lastCaretRef.current = displayCaret
      propsRef.current.onCaretChange?.(display, displayCaret)
    }
  }, [])

  const placeCaret = useCallback(
    (offset: number) => {
      if (placeTimerRef.current) clearTimeout(placeTimerRef.current)
      placeTimerRef.current = setTimeout(() => {
        placeTimerRef.current = null
        const id = textareaIdRef.current
        if (!liveRef.current || id === null || menuOpenRef.current) return
        if (!placeTextareaCaret(renderer, id, nativeRef.current, offset)) {
          void logFrontendError({
            level: 'warn',
            source: LOG_SOURCE,
            message: 'caret placement unavailable'
          })
        }
      }, CARET_SYNC_MS)
    },
    [renderer]
  )

  /** Adopt an edit; when the textarea does not already show its projection, write it and walk the caret back. */
  const apply = useCallback(
    (result: EditResult, nativeShows: string | null) => {
      docRef.current = result.doc
      caretRef.current = result.caret
      const projected = project(result.doc).text
      nativeRef.current = projected
      setText(projected)
      if (nativeShows !== projected && !menuOpenRef.current) placeCaret(result.caret)
      emit(result.doc, result.caret)
    },
    [emit, placeCaret]
  )

  const forwardKey = useCallback((init: KeyInit): boolean => {
    const event = composerKeyEvent(init, inputElementRef.current)
    return propsRef.current.onBeforeEditorKeyDown?.(event) === true || event.defaultPrevented
  }, [])

  // External value (send clears, seeds, menu splices): re-parse. The caret
  // goes to the end, as tiptap's setContent leaves it; hosts restore it.
  useLayoutEffect(() => {
    if (value === lastEmittedRef.current) return
    lastEmittedRef.current = value
    docRef.current = fromDisplay(value)
    const projected = project(docRef.current).text
    nativeRef.current = projected
    caretRef.current = projected.length
    lastCaretRef.current = toDisplayOffset(docRef.current, projected.length)
    setText(projected)
  }, [value])

  useEffect(() => {
    if (menuOpen) {
      const id = captureIdRef.current
      if (id !== null) renderer.focusElement?.(id)
      return
    }
    if (
      captureIdRef.current !== null &&
      renderer.getFocusedElementId?.() === captureIdRef.current
    ) {
      placeCaret(caretRef.current)
    }
  }, [menuOpen, renderer, placeCaret])

  const handle = useMemo<NativeComposerEditor>(
    () => ({
      isLive: () => liveRef.current,
      isEditable: () => !propsRef.current.disabled,
      displayCaret: () => toDisplayOffset(docRef.current, caretRef.current),
      focus: (position) => {
        if (position === 'end') caretRef.current = nativeRef.current.length
        placeCaret(caretRef.current)
      },
      blur: () => {
        const focused = renderer.getFocusedElementId?.()
        if (focused === textareaIdRef.current || focused === captureIdRef.current) renderer.blur?.()
      },
      setCaret: (displayOffset) => {
        caretRef.current = fromDisplayOffset(docRef.current, displayOffset)
        emit(docRef.current, caretRef.current)
        placeCaret(caretRef.current)
      },
      insertTrigger: (trigger) => {
        const display = toDisplay(docRef.current)
        const prefix = display.length > 0 && !/\s$/.test(display) ? ' ' : ''
        apply(insertText(docRef.current, nativeRef.current.length, `${prefix}${trigger}`), null)
      },
      get element() {
        return inputElementRef.current ? asHostElement(inputElementRef.current) : null
      }
    }),
    [apply, emit, placeCaret, renderer]
  )

  useEffect(() => {
    liveRef.current = true
    const { editorRef } = propsRef.current
    if (editorRef) editorRef.current = handle
    return () => {
      liveRef.current = false
      if (placeTimerRef.current) clearTimeout(placeTimerRef.current)
      if (editorRef?.current === handle) editorRef.current = null
    }
  }, [handle])

  const textareaRef = useCallback((instance: PublicInstance | null) => {
    textareaIdRef.current = instance?.id ?? null
    const element = instance ? new ComposerInputElement(instance.id, setMenuOpen) : null
    inputElementRef.current = element
    const { inputRef } = propsRef.current
    if (inputRef) inputRef.current = element ? asHostElement(element) : null
  }, [])

  const onChange = useCallback(
    (event: { value?: string | null }) => {
      const next = event.value ?? ''
      const result = reconcile(docRef.current, nativeRef.current, next, caretRef.current)
      apply(result, next)
    },
    [apply]
  )

  const onSubmit = useCallback(() => {
    if (forwardKey({ key: 'Enter' })) return
    apply(insertText(docRef.current, caretRef.current, '\n'), null)
  }, [apply, forwardKey])

  const onTextareaKeyDown = useCallback(
    (event: KeyEvent) => {
      const init = keyInitFrom(event)
      if (!init || isPrintable(init)) return
      if (forwardKey(init)) {
        event.preventDefault()
        return
      }
      if (
        init.key === 'v' &&
        (init.ctrlKey || init.metaKey) &&
        propsRef.current.onPasteAttachments
      ) {
        void logFrontendError({
          level: 'info',
          source: LOG_SOURCE,
          message: 'paste without text: GPUIX 0.11 cannot read clipboard images or files'
        })
      }
    },
    [forwardKey]
  )

  const onCaptureKeyDown = useCallback(
    (event: KeyEvent) => {
      const init = keyInitFrom(event)
      if (!init) return
      event.preventDefault()
      if (forwardKey(init) || propsRef.current.disabled) return
      const doc = docRef.current
      const caret = caretRef.current
      if (init.key === 'Backspace') apply(deleteBackward(doc, caret), null)
      else if (init.key === 'Delete') apply(deleteForward(doc, caret), null)
      else if (init.key === 'ArrowLeft' || init.key === 'ArrowRight') {
        caretRef.current = moveCaret(doc, caret, init.key === 'ArrowLeft' ? -1 : 1)
        emit(doc, caretRef.current)
      } else if (init.key === 'Enter') apply(insertText(doc, caret, '\n'), null)
      else if (isPrintable(init)) apply(insertText(doc, caret, init.key), null)
    },
    [apply, emit, forwardKey]
  )

  const tw = compatTw()
  const textStyle = tw(
    cn(
      'text-base leading-relaxed text-foreground outline-none pointer-fine:text-sm',
      editorClassName
    )
  )
  const lineHeight = typeof textStyle.lineHeight === 'number' ? textStyle.lineHeight : 22.75
  return (
    <div style={tw(cn('relative w-full overflow-hidden', disabled && 'opacity-60', className))}>
      <div style={{ ...tw('w-full'), maxHeight, minHeight, position: 'relative' }}>
        <textarea
          ref={textareaRef}
          testId="composer-editor"
          aria-label={ariaLabel}
          value={text}
          readOnly={disabled}
          // The web focuses once at mount and a read-only editor takes no focus, so a composer that mounts disabled stays unfocused.
          // biome-ignore lint/a11y/noAutofocus: hosts opt in (focus on chat open), as with the web editor's mount focus.
          autoFocus={autoFocus && !disabled}
          minRows={1}
          maxRows={Math.max(1, Math.floor(maxHeight / lineHeight))}
          style={{ ...textStyle, width: '100%', minHeight }}
          theme={{ caret: typeof textStyle.color === 'string' ? textStyle.color : undefined }}
          onChange={onChange}
          onSubmit={onSubmit}
          onKeyDown={onTextareaKeyDown}
          {...TRACK_FOCUS}
        />
        {text.length === 0 && placeholder ? (
          <div style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
            <text style={{ ...textStyle, ...tw('text-muted-foreground') }}>{placeholder}</text>
          </div>
        ) : null}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: an unlabeled focus sink; the textarea is the accessible editor and the menu is the listbox. */}
      <div
        ref={(instance: PublicInstance | null) => {
          captureIdRef.current = instance?.id ?? null
        }}
        testId="composer-key-capture"
        tabIndex={-1}
        style={CAPTURE_STYLE}
        onKeyDown={onCaptureKeyDown}
        {...TRACK_FOCUS}
      />
      {testHooksEnabled() ? (
        <div style={PROBE_STYLE}>
          <text testId="composer-editor-state">
            {JSON.stringify({ text, display: toDisplay(docRef.current), menuOpen })}
          </text>
        </div>
      ) : null}
    </div>
  )
}
