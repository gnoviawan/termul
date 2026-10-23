/**
 * The GPUIX code editor view. It paints an `EditorModel` (model.ts) and
 * turns keys, clicks, drags and wheel ticks into model commands.
 *
 * Painting: the visible lines' chunks (chunks.ts) as native `<code>`
 * elements, which highlight in Rust; the gutter's line numbers and fold
 * markers as one `<text>` per visible row; selection, active line and caret
 * as absolutely placed boxes. Scrolling is JS-owned (`scrollTop`,
 * `scrollLeft`), so the caret can always be followed and a point always maps
 * back to a position (layout.ts).
 *
 * Input: the root box takes focus and every key. Stock GPUIX 0.11 delivers
 * IME composition only to its own `<textarea>`/`<input>`, and those consume
 * arrows, Backspace, Enter and undo before JS sees them, so this editor has
 * no IME (a native textarea holding the document measured 70-1200ms per
 * keystroke at 5,000 lines anyway: tools/editor/probe).
 */

import { foldable } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import {
  type EventPayload,
  type KeyEvent,
  type PublicInstance,
  useGpuixRequired
} from '@gpuix/react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { useColorTheme } from '@/stores/app-settings-store'
import { transcriptThemes } from '../chat/theme'
import { tw } from '../style/tw'
import { copyText, pasteText } from '../terminal/clipboard'
import { CHUNK_LINES, chunksBetween, chunkStarts } from './chunks'
import { type KeyIntent, keyIntent } from './keymap'
import { loadLanguage, nativeGrammar } from './languages'
import {
  caretPoint,
  contentHeight,
  DEFAULT_CHAR_WIDTH,
  displayLine,
  FOLD_WIDTH,
  FONT_SIZE,
  followCaret,
  GUTTER_FONT,
  GUTTER_LINE_HEIGHT,
  gutterWidth,
  LINE_HEIGHT,
  lineTop,
  maxColumns,
  NUMBER_PAD_RIGHT,
  numbersWidth,
  PAD_LEFT,
  PAD_RIGHT,
  posAtPoint,
  selectionRects,
  type Viewport,
  visibleLines
} from './layout'
import {
  caretLineCol,
  createModel,
  type EditorCommand,
  type EditorModel,
  execute,
  posAtLineCol,
  reconfigure,
  replaceDocument,
  selectedText
} from './model'

const LOG_SOURCE = 'gpuix-editor'
const CHANGE_DEBOUNCE_MS = 300
const SCROLL_REPORT_MS = 300
const MONO_FAMILY = 'Paper Mono'
const PASSIVE = { pointerEvents: 'none' } as const

export interface CodeViewHandle {
  /** Push the buffer to `onChange` now instead of after the debounce. */
  flush(): void
  /** Put the caret on a line (selecting `term` when the line has it) and centre it. */
  revealLine(line: number, term?: string): void
  /** The text on screen. */
  text(): string
  /** First and last line on screen. */
  visibleRange(): { startLine: number; endLine: number }
}

export interface CodeViewProps {
  filePath: string
  content: string
  language: string
  readOnly?: boolean
  isVisible: boolean
  initialCursor?: { line: number; col: number }
  initialScrollTop?: number
  onChange: (content: string) => void
  onCursorChange?: (line: number, col: number) => void
  onScrollChange?: (scrollTop: number) => void
  onVisibleRangeChange?: (range: { startLine: number; endLine: number }) => void
  onSave: (content: string) => void
  handleRef?: (handle: CodeViewHandle | null) => void
  testId?: string
}

interface ChunkProps {
  text: string
  top: number
  left: number
  width: number
  grammar: string | undefined
  theme: ReturnType<typeof transcriptThemes>['code']
}

/** One `<code>`; memoised so a scroll that keeps the chunk's text costs no new highlight. */
const Chunk = memo(function Chunk({ text, top, left, width, grammar, theme }: ChunkProps) {
  return (
    <code
      code={text}
      {...(grammar ? { language: grammar } : {})}
      theme={theme}
      style={{
        position: 'absolute',
        top,
        left,
        width,
        fontFamily: MONO_FAMILY,
        fontSize: FONT_SIZE,
        lineHeight: LINE_HEIGHT,
        ...PASSIVE
      }}
    />
  )
})

function languageExtensions(language: Extension | null, readOnly: boolean): Extension[] {
  const extensions: Extension[] = []
  if (language) extensions.push(language)
  if (readOnly) extensions.push(EditorState.readOnly.of(true))
  return extensions
}

export function CodeView(props: CodeViewProps): React.JSX.Element {
  const { filePath, language, readOnly = false, isVisible, testId } = props
  const renderer = useGpuixRequired()
  const propsRef = useRef(props)
  propsRef.current = props

  const modelRef = useRef<EditorModel | null>(null)
  if (modelRef.current === null) {
    let model = createModel(props.content, languageExtensions(null, readOnly))
    if (props.initialCursor) {
      const pos = posAtLineCol(model.state, props.initialCursor.line, props.initialCursor.col)
      model = execute(model, { kind: 'cursor', pos, extend: false }, { pageLines: 1 })
    }
    modelRef.current = model
  }
  const [, setRevision] = useState(0)
  const [viewport, setViewportState] = useState<Viewport>({
    width: 0,
    height: 0,
    scrollTop: Math.max(0, props.initialScrollTop ?? 0),
    scrollLeft: 0,
    charWidth: DEFAULT_CHAR_WIDTH
  })
  const viewportRef = useRef(viewport)
  const originRef = useRef({ x: 0, y: 0 })
  const rootIdRef = useRef<number | null>(null)
  const [focused, setFocused] = useState(false)
  const changeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastEmitted = useRef(props.content)
  const widestRef = useRef<{ doc: unknown; columns: number }>({ doc: null, columns: 0 })
  const dragging = useRef(false)

  const state = modelRef.current.state
  const lines = state.doc.lines
  const gutter = gutterWidth(lines)

  const setViewport = useCallback((next: Partial<Viewport>) => {
    const merged = { ...viewportRef.current, ...next }
    viewportRef.current = merged
    setViewportState(merged)
  }, [])

  const limits = useCallback(() => {
    const { doc } = modelRef.current!.state
    if (widestRef.current.doc !== doc) {
      widestRef.current = { doc, columns: maxColumns(modelRef.current!.state) }
    }
    const vp = viewportRef.current
    const contentWidth = Math.max(0, vp.width - gutter)
    return {
      maxTop: Math.max(0, contentHeight(doc.lines) - vp.height),
      maxLeft: Math.max(
        0,
        PAD_LEFT + widestRef.current.columns * vp.charWidth + PAD_RIGHT + vp.charWidth - contentWidth
      )
    }
  }, [gutter])

  const reportScroll = useCallback(() => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current)
    scrollTimer.current = setTimeout(() => {
      const vp = viewportRef.current
      propsRef.current.onScrollChange?.(vp.scrollTop)
      const [startLine, endLine] = visibleLines(modelRef.current!.state.doc.lines, vp)
      propsRef.current.onVisibleRangeChange?.({ startLine, endLine })
    }, SCROLL_REPORT_MS)
  }, [])

  const flush = useCallback(() => {
    if (changeTimer.current) {
      clearTimeout(changeTimer.current)
      changeTimer.current = null
    }
    const text = modelRef.current!.state.doc.toString()
    if (text !== lastEmitted.current) {
      lastEmitted.current = text
      propsRef.current.onChange(text)
    }
  }, [])

  /** Adopt a new model: schedule the change report, report the caret, follow it. */
  const commit = useCallback(
    (next: EditorModel, follow: boolean) => {
      const prev = modelRef.current!
      if (next === prev) return
      modelRef.current = next
      if (next.state.doc !== prev.state.doc) {
        if (changeTimer.current) clearTimeout(changeTimer.current)
        changeTimer.current = setTimeout(flush, CHANGE_DEBOUNCE_MS)
      }
      if (!next.state.selection.eq(prev.state.selection)) {
        const { line, col } = caretLineCol(next.state)
        propsRef.current.onCursorChange?.(line, col)
      }
      if (follow) {
        const { maxTop, maxLeft } = limits()
        const scroll = followCaret(
          next.state,
          next.state.selection.main.head,
          { ...viewportRef.current, width: viewportRef.current.width - gutter },
          maxTop,
          maxLeft
        )
        const vp = viewportRef.current
        if (scroll.scrollTop !== vp.scrollTop || scroll.scrollLeft !== vp.scrollLeft) {
          setViewport(scroll)
          reportScroll()
        }
      }
      setRevision((r) => r + 1)
    },
    [flush, gutter, limits, reportScroll, setViewport]
  )

  const run = useCallback(
    (command: EditorCommand, follow = true) => {
      const pageLines = Math.max(1, Math.floor(viewportRef.current.height / LINE_HEIGHT) - 1)
      commit(execute(modelRef.current!, command, { pageLines }), follow)
    },
    [commit]
  )

  // Language and read-only are configuration: swap them in without losing history.
  useEffect(() => {
    let cancelled = false
    void loadLanguage(language, /\.(tsx|jsx)$/i.test(filePath) || language === 'javascript').then(
      (support) => {
        if (cancelled || !modelRef.current) return
        modelRef.current = reconfigure(modelRef.current, languageExtensions(support, readOnly))
        setRevision((r) => r + 1)
      }
    )
    return () => {
      cancelled = true
    }
  }, [filePath, language, readOnly])

  // A different `content` than the last one this view emitted is external (reload).
  useEffect(() => {
    if (props.content === lastEmitted.current) return
    if (props.content === modelRef.current!.state.doc.toString()) {
      lastEmitted.current = props.content
      return
    }
    lastEmitted.current = props.content
    modelRef.current = replaceDocument(modelRef.current!, props.content)
    setRevision((r) => r + 1)
  }, [props.content])

  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      if (changeTimer.current) flush()
    },
    [flush]
  )

  const revealLine = useCallback(
    (lineNumber: number, term?: string) => {
      const { state: current } = modelRef.current!
      const line = current.doc.line(Math.min(Math.max(1, lineNumber), current.doc.lines))
      const needle = term?.trim().toLowerCase()
      const index = needle ? line.text.toLowerCase().indexOf(needle) : -1
      run(
        index >= 0 && needle
          ? { kind: 'select', anchor: line.from + index, head: line.from + index + needle.length }
          : { kind: 'cursor', pos: line.from, extend: false },
        false
      )
      const vp = viewportRef.current
      const { maxTop } = limits()
      setViewport({
        scrollTop: Math.min(maxTop, Math.max(0, lineTop(line.number) - vp.height / 2))
      })
      reportScroll()
      if (rootIdRef.current !== null) renderer.focusElement?.(rootIdRef.current)
    },
    [limits, renderer, reportScroll, run, setViewport]
  )

  const handle = useMemo<CodeViewHandle>(
    () => ({
      flush,
      revealLine,
      text: () => modelRef.current!.state.doc.toString(),
      visibleRange: () => {
        const [startLine, endLine] = visibleLines(
          modelRef.current!.state.doc.lines,
          viewportRef.current
        )
        return { startLine, endLine }
      }
    }),
    [flush, revealLine]
  )
  useEffect(() => {
    const { handleRef } = propsRef.current
    handleRef?.(handle)
    return () => handleRef?.(null)
  }, [handle])

  useEffect(() => {
    if (isVisible && rootIdRef.current !== null) renderer.focusElement?.(rootIdRef.current)
  }, [isVisible, renderer])

  const clipboard = useCallback(
    async (intent: Extract<KeyIntent, { kind: 'copy' | 'cut' | 'paste' }>) => {
      try {
        if (intent.kind === 'paste') {
          const text = await pasteText()
          if (text) run({ kind: 'insert', text })
          return
        }
        const text = selectedText(modelRef.current!)
        if (!text) return
        await copyText(text)
        if (intent.kind === 'cut') run({ kind: 'run', command: 'deleteCharBackward' })
      } catch (error) {
        void logFrontendError({
          level: 'warn',
          source: `${LOG_SOURCE}.clipboard`,
          message: `${intent.kind} failed (${String(error)})`
        })
      }
    },
    [run]
  )

  const onKeyDown = useCallback(
    (event: KeyEvent) => {
      const intent = keyIntent({ key: event.key ?? '', keyChar: event.keyChar, modifiers: event.modifiers })
      if (!intent) return
      event.preventDefault()
      event.stopPropagation()
      switch (intent.kind) {
        case 'edit':
          run(intent.command)
          return
        case 'save':
          flush()
          propsRef.current.onSave(modelRef.current!.state.doc.toString())
          return
        default:
          void clipboard(intent)
      }
    },
    [clipboard, flush, run]
  )

  const pointPos = useCallback((event: EventPayload) => {
    const x = (event.x ?? 0) - originRef.current.x - gutter
    const y = (event.y ?? 0) - originRef.current.y
    return posAtPoint(modelRef.current!.state, x, y, viewportRef.current)
  }, [gutter])

  const onMouseDown = useCallback(
    (event: EventPayload) => {
      if (rootIdRef.current !== null) renderer.focusElement?.(rootIdRef.current)
      if ((event.button ?? 0) !== 0) return
      const pos = pointPos(event)
      const clicks = event.clickCount ?? 1
      const { state: current } = modelRef.current!
      if (clicks >= 3) {
        const line = current.doc.lineAt(pos)
        run({ kind: 'select', anchor: line.from, head: Math.min(current.doc.length, line.to + 1) }, false)
      } else if (clicks === 2) {
        const word = current.wordAt(pos)
        if (word) run({ kind: 'select', anchor: word.from, head: word.to }, false)
      } else {
        run({ kind: 'cursor', pos, extend: event.modifiers?.shift === true }, false)
      }
      dragging.current = clicks === 1
    },
    [pointPos, renderer, run]
  )

  const onMouseMove = useCallback(
    (event: EventPayload) => {
      if (!dragging.current || event.pressedButton !== 0) return
      run({ kind: 'cursor', pos: pointPos(event), extend: true })
    },
    [pointPos, run]
  )

  const onScroll = useCallback(
    (event: EventPayload) => {
      const unit = event.precise ? 1 : LINE_HEIGHT
      const dy = (event.deltaY ?? 0) * unit
      const dx = (event.deltaX ?? 0) * unit
      const shiftWheel = event.modifiers?.shift === true && dx === 0
      const { maxTop, maxLeft } = limits()
      const vp = viewportRef.current
      const next = {
        scrollTop: shiftWheel ? vp.scrollTop : Math.min(maxTop, Math.max(0, vp.scrollTop - dy)),
        scrollLeft: Math.min(maxLeft, Math.max(0, vp.scrollLeft - (shiftWheel ? dy : dx)))
      }
      if (next.scrollTop !== vp.scrollTop || next.scrollLeft !== vp.scrollLeft) {
        setViewport(next)
        reportScroll()
      }
    },
    [limits, reportScroll, setViewport]
  )

  const onLayout = useCallback(
    (event: EventPayload) => {
      originRef.current = { x: event.x ?? 0, y: event.y ?? 0 }
      setViewport({ width: event.width ?? 0, height: event.height ?? 0 })
      reportScroll()
    },
    [reportScroll, setViewport]
  )

  const onMeasure = useCallback(
    (event: EventPayload) => {
      const width = event.width ?? 0
      if (width > 0) setViewport({ charWidth: width / 100 })
    },
    [setViewport]
  )

  const themeId = useColorTheme()
  const codeTheme = useMemo(() => {
    const base = transcriptThemes(themeId).code
    return {
      ...base,
      fontMono: MONO_FAMILY,
      metrics: { ...base.metrics, codeTextSize: FONT_SIZE, codeLineHeight: LINE_HEIGHT }
    }
  }, [themeId])
  const colors = useMemo(
    () => ({
      background: tw('bg-background').backgroundColor as string,
      card: tw('bg-card').backgroundColor as string,
      border: tw('border-border').borderColor as string,
      muted: tw('text-muted-foreground').color as string,
      foreground: tw('text-foreground').color as string,
      activeLine: tw('bg-foreground/[0.03]').backgroundColor as string,
      selection: tw('bg-foreground/[0.14]').backgroundColor as string,
      caret: tw('bg-primary').backgroundColor as string
    }),
    // biome-ignore lint/correctness/useExhaustiveDependencies: tw() reads the applied theme's tokens
    [themeId]
  )

  const vp = viewport
  const contentWidth = Math.max(0, vp.width - gutter)
  const [first, last] = visibleLines(lines, vp)
  const starts = useMemo(() => chunkStarts(state), [state])
  const chunks = chunksBetween(starts, lines, first, last)
  const chunkTexts = chunks.map((chunk) =>
    state
      .sliceDoc(state.doc.line(chunk.startLine).from, state.doc.line(chunk.endLine).to)
      .split('\n')
      .map((line) => displayLine(line, state.tabSize))
      .join('\n')
  )
  const grammar = nativeGrammar(language, filePath)
  const head = state.selection.main.head
  const headLine = state.doc.lineAt(head).number
  const caret = caretPoint(state, head, vp.charWidth)
  const rightEdge = vp.scrollLeft + contentWidth
  const codeWidth = Math.max(contentWidth, PAD_LEFT + widestRef.current.columns * vp.charWidth + 64)

  const gutterRows: React.JSX.Element[] = []
  const numbersBox = numbersWidth(lines)
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n)
    const top = lineTop(n) - vp.scrollTop
    gutterRows.push(
      <text
        key={`n${n}`}
        style={{
          position: 'absolute',
          top,
          left: 0,
          width: numbersBox - NUMBER_PAD_RIGHT,
          textAlign: 'right',
          fontFamily: GUTTER_FONT,
          fontSize: FONT_SIZE,
          lineHeight: GUTTER_LINE_HEIGHT,
          color: n === headLine ? colors.foreground : colors.muted,
          whiteSpace: 'nowrap',
          ...PASSIVE
        }}
      >
        {String(n)}
      </text>
    )
    if (foldable(state, line.from, line.to)) {
      gutterRows.push(
        <text
          key={`f${n}`}
          style={{
            position: 'absolute',
            top,
            left: numbersBox + 1,
            width: FOLD_WIDTH - 2,
            fontFamily: GUTTER_FONT,
            fontSize: FONT_SIZE,
            lineHeight: GUTTER_LINE_HEIGHT,
            color: colors.muted,
            ...PASSIVE
          }}
        >
          ⌄
        </text>
      )
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the editor surface; GPUIX has no textbox role with a custom painter
    <div
      ref={(instance: PublicInstance | null) => {
        rootIdRef.current = instance?.id ?? null
      }}
      testId={testId}
      role="textbox"
      aria-label={`Editor ${filePath}`}
      tabIndex={0}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: colors.background,
        cursor: 'text'
      }}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={() => {
        dragging.current = false
      }}
      onScroll={onScroll}
      onLayout={onLayout}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: gutter,
          height: vp.height,
          backgroundColor: colors.card,
          borderRightWidth: 1,
          borderColor: colors.border,
          overflow: 'hidden',
          ...PASSIVE
        }}
      >
        {gutterRows}
      </div>
      <div
        style={{
          position: 'absolute',
          left: gutter,
          top: 0,
          width: contentWidth,
          height: vp.height,
          overflow: 'hidden',
          ...PASSIVE
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: lineTop(headLine) - vp.scrollTop,
            width: contentWidth,
            height: LINE_HEIGHT,
            backgroundColor: colors.activeLine,
            ...PASSIVE
          }}
        />
        {selectionRects(state, first, last, vp.charWidth, rightEdge).map((rect) => (
          <div
            key={`s${rect.y}`}
            style={{
              position: 'absolute',
              left: rect.x - vp.scrollLeft,
              top: rect.y - vp.scrollTop,
              width: rect.width,
              height: rect.height,
              backgroundColor: colors.selection,
              ...PASSIVE
            }}
          />
        ))}
        {chunks.map((chunk, index) => {
          const text = chunkTexts[index]!
          return (
            <Chunk
              key={chunk.startLine}
              text={text}
              top={lineTop(chunk.startLine) - vp.scrollTop}
              left={PAD_LEFT - vp.scrollLeft}
              width={codeWidth}
              grammar={grammar}
              theme={codeTheme}
            />
          )
        })}
        {focused && !readOnly ? (
          <div
            testId={testId ? `${testId}-caret` : undefined}
            style={{
              position: 'absolute',
              left: caret.x - vp.scrollLeft,
              top: caret.y - vp.scrollTop,
              width: 1.2,
              height: LINE_HEIGHT,
              backgroundColor: colors.caret,
              ...PASSIVE
            }}
          />
        ) : null}
      </div>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, overflow: 'hidden' }}>
        <text
          onLayout={onMeasure}
          style={{ fontFamily: MONO_FAMILY, fontSize: FONT_SIZE, whiteSpace: 'nowrap' }}
        >
          {'M'.repeat(100)}
        </text>
      </div>
      {testHooksEnabled() ? (
        <div style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, overflow: 'hidden' }}>
          <text testId={testId ? `${testId}-state` : 'code-view-state'}>
            {JSON.stringify({
              caret: caretLineCol(state),
              lines,
              scrollTop: Math.round(vp.scrollTop),
              first,
              last,
              chunks: chunks.length,
              painted: chunkTexts
                .join('\n')
                .split('\n')
                .slice(first - (chunks[0]?.startLine ?? first), last - (chunks[0]?.startLine ?? first) + 1),
              charWidth: vp.charWidth,
              chunkLines: CHUNK_LINES
            })}
          </text>
        </div>
      ) : null}
    </div>
  )
}

/** Set by test scenes: the automation tree does not carry editor state, so the view mirrors it into an unpainted text. */
function testHooksEnabled(): boolean {
  return (
    (globalThis as { __TERMUL_GPUIX_TEST_HOOKS__?: boolean }).__TERMUL_GPUIX_TEST_HOOKS__ === true ||
    (typeof process !== 'undefined' && process.env.TERMUL_GPUIX_TEST_HOOKS === '1')
  )
}
