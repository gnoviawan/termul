import { useRef, useEffect } from 'react'
import { useCodeMirror } from '@/hooks/use-codemirror'

interface CodeEditorProps {
  filePath: string
  content: string
  language: string
  readOnly?: boolean
  isVisible: boolean
  onChange: (content: string) => void
  onCursorChange: (line: number, col: number) => void
  onScrollChange: (scrollTop: number) => void
}

export function CodeEditor({
  content,
  language,
  readOnly = false,
  isVisible,
  onChange,
  onCursorChange,
  onScrollChange
}: CodeEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const { view, setContent } = useCodeMirror(containerRef, {
    content,
    language,
    readOnly,
    onChange,
    onCursorChange,
    onScrollChange
  })

  // Update content when it changes from external source (file reload)
  const prevContentRef = useRef(content)
  useEffect(() => {
    if (content !== prevContentRef.current) {
      setContent(content)
      prevContentRef.current = content
    }
  }, [content, setContent])

  // Focus when becoming visible
  useEffect(() => {
    if (isVisible && view) {
      view.focus()
    }
  }, [isVisible, view])

  return (
    <div ref={containerRef} className="w-full h-full overflow-hidden" />
  )
}
