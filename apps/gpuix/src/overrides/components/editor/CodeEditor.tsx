/**
 * GPUIX twin of `components/editor/CodeEditor.tsx`: the same props and store
 * wiring (debounced `onChange`, the content flusher save runs first, Mod-s
 * through `requestSaveEditorFile`, cursor and scroll restore, and the
 * `termul:reveal-line` event), painted by the native `CodeView` instead of a
 * CodeMirror DOM view.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorTocLayout } from '@/components/editor/EditorTocLayout'
import { TocPanel } from '@/components/editor/TocPanel'
import type { VisibleLineRange } from '@/hooks/use-codemirror'
import {
  registerEditorContentFlusher,
  unregisterEditorContentFlusher
} from '@/lib/editor-content-flush'
import { requestSaveEditorFile } from '@/lib/editor-save'
import { CodeView, type CodeViewHandle } from '../../../editor/CodeView'
import { tw } from '../../../style/tw'

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

interface PendingReveal {
  filePath: string
  lineNumber: number
  searchTerm?: string
}

type RevealWindow = { __termulPendingRevealLine?: PendingReveal }

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
  const viewRef = useRef<CodeViewHandle | null>(null)
  const [view, setView] = useState<CodeViewHandle | null>(null)
  const [visibleRange, setVisibleRange] = useState<VisibleLineRange | undefined>()
  const pendingReveal = useRef<{ line: number; term?: string } | null>(null)

  const onHandle = useCallback((handle: CodeViewHandle | null) => {
    viewRef.current = handle
    setView(handle)
  }, [])

  useEffect(() => {
    registerEditorContentFlusher(filePath, () => viewRef.current?.flush())
    return () => unregisterEditorContentFlusher(filePath)
  }, [filePath])

  const scrollToLine = useCallback((line: number, term?: string) => {
    viewRef.current?.revealLine(line, term)
  }, [])

  useEffect(() => {
    const host = window as unknown as RevealWindow
    const pending = host.__termulPendingRevealLine
    if (pending && pending.filePath === filePath && isVisible && view) {
      view.revealLine(pending.lineNumber, pending.searchTerm)
      host.__termulPendingRevealLine = undefined
    }
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<PendingReveal>).detail
      if (!detail || detail.filePath !== filePath) return
      host.__termulPendingRevealLine = undefined
      if (!isVisible || !viewRef.current) {
        pendingReveal.current = { line: detail.lineNumber, term: detail.searchTerm }
        return
      }
      viewRef.current.revealLine(detail.lineNumber, detail.searchTerm)
    }
    window.addEventListener('termul:reveal-line', handler)
    return () => window.removeEventListener('termul:reveal-line', handler)
  }, [filePath, isVisible, view])

  useEffect(() => {
    if (!isVisible || !view || !pendingReveal.current) return
    view.revealLine(pendingReveal.current.line, pendingReveal.current.term)
    pendingReveal.current = null
  }, [isVisible, view])

  return (
    <EditorTocLayout
      isVisible={isVisible}
      hasOutline={language === 'markdown'}
      renderOutline={(variant: string) => (
        <TocPanel
          variant={variant}
          filePath={filePath}
          editorMode="codemirror"
          codemirror={{
            content,
            scrollToLine,
            visibleRange,
            scrollElement: null,
            isLoading: !view
          }}
        />
      )}
    >
      <div style={tw('relative h-full min-w-0 flex-1')}>
        <CodeView
          key={filePath}
          filePath={filePath}
          content={content}
          language={language}
          readOnly={readOnly}
          isVisible={isVisible}
          initialCursor={initialCursorPosition}
          initialScrollTop={initialScrollTop}
          onChange={onChange}
          onCursorChange={onCursorChange}
          onScrollChange={onScrollChange}
          onVisibleRangeChange={setVisibleRange}
          onSave={() => void requestSaveEditorFile(filePath)}
          handleRef={onHandle}
          testId={`code-editor-${filePath.split(/[\\/]/).pop()}`}
        />
      </div>
    </EditorTocLayout>
  )
}
