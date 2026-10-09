import { useEffect, useRef, useState } from 'react'
import { useCodeMirror, type VisibleLineRange } from '@/hooks/use-codemirror'
import {
  registerEditorContentFlusher,
  unregisterEditorContentFlusher
} from '@/lib/editor-content-flush'
import { EditorTocLayout } from './EditorTocLayout'
import { TocPanel } from './TocPanel'

interface CodeEditorProps {
  filePath: string
  content: string
  language: string
  readOnly?: boolean
  isVisible: boolean
  initialCursorPosition?: { line: number; col: number }
  initialScrollTop?: number
  onChange: (content: string) => void
  onCursorChange: (line: number, col: number) => void
  onScrollChange: (scrollTop: number) => void
}

export function CodeEditor({
  filePath,
  content,
  language,
  readOnly = false,
  isVisible,
  initialCursorPosition,
  initialScrollTop = 0,
  onChange,
  onCursorChange,
  onScrollChange
}: CodeEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const lastAppliedLineRef = useRef<number | null>(null)
  const pendingRevealLineRef = useRef<number | null>(null)
  const pendingRevealTermRef = useRef<string | undefined>(undefined)
  const hasRestoredViewStateRef = useRef(false)
  const [visibleRange, setVisibleRange] = useState<VisibleLineRange | undefined>()

  const { view, isReady, setContent, flushPendingContent, scrollToLine, restoreViewState } =
    useCodeMirror(containerRef, {
      filePath,
      content,
      language,
      readOnly,
      onChange,
      onCursorChange,
      onScrollChange,
      onVisibleRangeChange: setVisibleRange
    })

  useEffect(() => {
    registerEditorContentFlusher(filePath, flushPendingContent)
    return () => unregisterEditorContentFlusher(filePath)
  }, [filePath, flushPendingContent])

  // Update content when it changes from external source (file reload)
  const prevContentRef = useRef(content)
  useEffect(() => {
    if (content !== prevContentRef.current) {
      setContent(content)
      prevContentRef.current = content
    }
  }, [content, setContent])

  // biome-ignore lint/correctness/useExhaustiveDependencies: filePath intentionally retriggers the effect
  useEffect(() => {
    lastAppliedLineRef.current = null
    pendingRevealLineRef.current = null
    pendingRevealTermRef.current = undefined
    hasRestoredViewStateRef.current = false
  }, [filePath])

  // Focus when becoming visible
  useEffect(() => {
    if (isVisible && view) {
      view.focus()
    }
  }, [isVisible, view])

  useEffect(() => {
    if (hasRestoredViewStateRef.current) {
      return
    }

    const initialLine = initialCursorPosition?.line
    const initialCol = initialCursorPosition?.col ?? 1

    if (!initialLine) {
      return
    }

    // Intentionally wait until the editor is visible before restoring view state.
    // Hidden mounts don't have stable layout metrics yet; restoring too early can
    // misplace cursor/scroll. Keep `isVisible` in dependencies to retry when shown.
    if (!view || !isVisible) {
      return
    }

    restoreViewState(initialLine, initialCol, initialScrollTop)
    hasRestoredViewStateRef.current = true
    lastAppliedLineRef.current = initialLine
  }, [initialCursorPosition, initialScrollTop, isVisible, restoreViewState, view])

  useEffect(() => {
    const pending = (
      window as unknown as {
        __termulPendingRevealLine?: { filePath: string; lineNumber: number; searchTerm?: string }
      }
    ).__termulPendingRevealLine

    if (pending && pending.filePath === filePath && isVisible && view) {
      scrollToLine(pending.lineNumber, pending.searchTerm)
      lastAppliedLineRef.current = pending.lineNumber
      pendingRevealLineRef.current = null
      pendingRevealTermRef.current = undefined
      ;(window as unknown as { __termulPendingRevealLine?: unknown }).__termulPendingRevealLine =
        undefined
    }

    const handler = (event: Event): void => {
      const customEvent = event as CustomEvent<{
        filePath: string
        lineNumber: number
        searchTerm?: string
      }>
      if (!customEvent.detail) return
      if (customEvent.detail.filePath !== filePath) return

      if (!isVisible || !view) {
        pendingRevealLineRef.current = customEvent.detail.lineNumber
        pendingRevealTermRef.current = customEvent.detail.searchTerm
        return
      }

      scrollToLine(customEvent.detail.lineNumber, customEvent.detail.searchTerm)
      lastAppliedLineRef.current = customEvent.detail.lineNumber
      pendingRevealLineRef.current = null
      pendingRevealTermRef.current = undefined
    }

    window.addEventListener('termul:reveal-line', handler)
    return () => window.removeEventListener('termul:reveal-line', handler)
  }, [filePath, isVisible, scrollToLine, view])

  useEffect(() => {
    if (!isVisible || !view || pendingRevealLineRef.current == null) {
      return
    }

    scrollToLine(pendingRevealLineRef.current, pendingRevealTermRef.current)
    lastAppliedLineRef.current = pendingRevealLineRef.current
    pendingRevealLineRef.current = null
    pendingRevealTermRef.current = undefined
  }, [isVisible, scrollToLine, view])

  return (
    <EditorTocLayout
      isVisible={isVisible}
      hasOutline={language === 'markdown'}
      renderOutline={(variant) => (
        <TocPanel
          variant={variant}
          filePath={filePath}
          editorMode="codemirror"
          codemirror={{
            content,
            scrollToLine,
            visibleRange,
            scrollElement: view?.scrollDOM ?? null,
            isLoading: !isReady
          }}
        />
      )}
    >
      <div className="relative h-full min-w-0 flex-1">
        <div ref={containerRef} className="w-full h-full overflow-hidden" />
        {!isReady && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <span className="text-sm text-muted-foreground animate-pulse motion-reduce:animate-none">
              Loading...
            </span>
          </div>
        )}
      </div>
    </EditorTocLayout>
  )
}
