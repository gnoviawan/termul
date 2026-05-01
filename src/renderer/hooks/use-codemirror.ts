import { useRef, useEffect, useCallback, useState } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap
} from '@codemirror/view'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches } from '@codemirror/search'
import { createTermulTheme } from '@/components/editor/codemirror-theme'
import type { Extension } from '@codemirror/state'

// Cache loaded language extensions
const languageCache = new Map<string, Extension>()

async function loadLanguage(lang: string): Promise<Extension | null> {
  if (languageCache.has(lang)) {
    return languageCache.get(lang)!
  }

  let extension: Extension | null = null

  try {
    switch (lang) {
      case 'javascript':
      case 'typescript': {
        const { javascript } = await import('@codemirror/lang-javascript')
        extension = javascript({ typescript: lang === 'typescript', jsx: true })
        break
      }
      case 'json': {
        const { json } = await import('@codemirror/lang-json')
        extension = json()
        break
      }
      case 'css': {
        const { css } = await import('@codemirror/lang-css')
        extension = css()
        break
      }
      case 'html': {
        const { html } = await import('@codemirror/lang-html')
        extension = html()
        break
      }
      case 'markdown': {
        const { markdown } = await import('@codemirror/lang-markdown')
        extension = markdown()
        break
      }
      case 'python': {
        const { python } = await import('@codemirror/lang-python')
        extension = python()
        break
      }
      case 'rust': {
        const { rust } = await import('@codemirror/lang-rust')
        extension = rust()
        break
      }
      case 'yaml': {
        const { yaml } = await import('@codemirror/lang-yaml')
        extension = yaml()
        break
      }
      case 'toml':
        // No built-in CodeMirror TOML support; fall through to plain text
        return null
      default:
        return null
    }
  } catch {
    return null
  }

  if (extension) {
    languageCache.set(lang, extension)
  }
  return extension
}

export interface VisibleLineRange {
  startLine: number
  endLine: number
}

interface UseCodeMirrorOptions {
  content: string
  language: string
  readOnly?: boolean
  onChange: (content: string) => void
  onCursorChange: (line: number, col: number) => void
  onScrollChange: (scrollTop: number) => void
  onVisibleRangeChange?: (range: VisibleLineRange) => void
}

interface UseCodeMirrorResult {
  view: EditorView | null
  setContent: (content: string) => void
  scrollToLine: (lineNumber: number) => void
  getVisibleLineRange: () => VisibleLineRange | null
}

function getVisibleLineRangeForView(view: EditorView): VisibleLineRange {
  const { from, to } = view.viewport

  return {
    startLine: view.state.doc.lineAt(from).number,
    endLine: view.state.doc.lineAt(to).number
  }
}

export function useCodeMirror(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options: UseCodeMirrorOptions
): UseCodeMirrorResult {
  const viewRef = useRef<EditorView | null>(null)
  const [viewReady, setViewReady] = useState(false)
  const onChangeRef = useRef(options.onChange)
  const onCursorChangeRef = useRef(options.onCursorChange)
  const onScrollChangeRef = useRef(options.onScrollChange)
  const onVisibleRangeChangeRef = useRef(options.onVisibleRangeChange)
  const contentRef = useRef(options.content)
  const isExternalUpdate = useRef(false)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visibleRangeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const themeCompartment = useRef(new Compartment())

  // Keep refs up to date
  onChangeRef.current = options.onChange
  onCursorChangeRef.current = options.onCursorChange
  onScrollChangeRef.current = options.onScrollChange
  onVisibleRangeChangeRef.current = options.onVisibleRangeChange
  contentRef.current = options.content

  // Create editor
  useEffect(() => {
    if (!containerRef.current) return

    const isDark = document.documentElement.classList.contains('dark')

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !isExternalUpdate.current) {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
        }
        debounceTimerRef.current = setTimeout(() => {
          const content = update.state.doc.toString()
          onChangeRef.current(content)
        }, 300)
      }

      if (update.selectionSet) {
        const pos = update.state.selection.main.head
        const line = update.state.doc.lineAt(pos)
        onCursorChangeRef.current(line.number, pos - line.from + 1)
      }
    })

    const scrollListener = EditorView.domEventHandlers({
      scroll: (_event, view) => {
        if (scrollDebounceRef.current) {
          clearTimeout(scrollDebounceRef.current)
        }
        scrollDebounceRef.current = setTimeout(() => {
          onScrollChangeRef.current(view.scrollDOM.scrollTop)
        }, 300)

        if (visibleRangeDebounceRef.current) {
          clearTimeout(visibleRangeDebounceRef.current)
        }
        visibleRangeDebounceRef.current = setTimeout(() => {
          onVisibleRangeChangeRef.current?.(getVisibleLineRangeForView(view))
        }, 100)
        return false
      }
    })

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      foldGutter(),
      indentOnInput(),
      history(),
      highlightSelectionMatches(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      themeCompartment.current.of(createTermulTheme(isDark)),
      updateListener,
      scrollListener,
      EditorView.lineWrapping
    ]

    if (options.readOnly) {
      extensions.push(EditorState.readOnly.of(true))
    }

    // Cancellation flag to prevent stale async completions from leaking EditorViews
    let cancelled = false

    // Load language asynchronously
    const initEditor = async (): Promise<void> => {
      const langExtension = await loadLanguage(options.language)
      if (cancelled) return

      if (langExtension) {
        extensions.push(langExtension)
      }

      if (!containerRef.current) return

      const state = EditorState.create({
        doc: contentRef.current,
        extensions
      })

      if (cancelled) return

      const view = new EditorView({
        state,
        parent: containerRef.current
      })

      if (cancelled) {
        view.destroy()
        return
      }

      viewRef.current = view
      onVisibleRangeChangeRef.current?.(getVisibleLineRangeForView(view))
      setViewReady(true)
    }

    initEditor()

    return () => {
      cancelled = true
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
        // Flush the pending change so the last edit isn't lost
        if (viewRef.current) {
          onChangeRef.current(viewRef.current.state.doc.toString())
        }
      }
      if (scrollDebounceRef.current) {
        clearTimeout(scrollDebounceRef.current)
      }
      if (visibleRangeDebounceRef.current) {
        clearTimeout(visibleRangeDebounceRef.current)
      }
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
      setViewReady(false)
    }
  }, [containerRef, options.language, options.readOnly])

  // Watch for dark/light theme changes via MutationObserver
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const view = viewRef.current
      if (!view) return
      const isDarkNow = document.documentElement.classList.contains('dark')
      view.dispatch({
        effects: themeCompartment.current.reconfigure(createTermulTheme(isDarkNow))
      })
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    })

    return () => observer.disconnect()
  }, [])

  const setContent = useCallback((content: string) => {
    const view = viewRef.current
    if (!view) return

    const currentContent = view.state.doc.toString()
    if (currentContent === content) return

    isExternalUpdate.current = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content }
    })
    isExternalUpdate.current = false
  }, [])

  const scrollToLine = useCallback((lineNumber: number) => {
    const view = viewRef.current
    if (!view) return

    const safeLineNumber = Math.min(Math.max(1, lineNumber), view.state.doc.lines)
    const line = view.state.doc.line(safeLineNumber)
    const lineBlock = view.lineBlockAt(line.from)
    const targetScrollTop = lineBlock.top

    view.dispatch({
      selection: { anchor: line.from }
    })

    view.scrollDOM.scrollTo({
      top: targetScrollTop,
      behavior: 'smooth'
    })

    onScrollChangeRef.current(targetScrollTop)
    onVisibleRangeChangeRef.current?.(getVisibleLineRangeForView(view))
    view.focus()
  }, [])

  const getVisibleLineRange = useCallback((): VisibleLineRange | null => {
    const view = viewRef.current
    if (!view) {
      return null
    }

    return getVisibleLineRangeForView(view)
  }, [])

  return {
    view: viewReady ? viewRef.current : null,
    setContent,
    scrollToLine,
    getVisibleLineRange
  }
}
