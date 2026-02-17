import { useState, useEffect, useRef, useCallback } from 'react'
import { useBlockNote } from '@/hooks/use-blocknote'
import { BlockNoteViewRaw } from '@blocknote/react'
import '@blocknote/react/style.css'

interface MarkdownEditorProps {
  filePath: string
  content: string
  isVisible: boolean
  onChange: (content: string) => void
}

function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(
    document.documentElement.classList.contains('dark')
  )

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    })

    return () => observer.disconnect()
  }, [])

  return isDark
}

export function MarkdownEditor({
  content,
  isVisible,
  onChange
}: MarkdownEditorProps): React.JSX.Element {
  // Track whether the last content change came from this editor's onChange
  const isLocalChangeRef = useRef(false)
  const prevContentRef = useRef(content)

  const wrappedOnChange = useCallback(
    (newContent: string) => {
      isLocalChangeRef.current = true
      prevContentRef.current = newContent
      onChange(newContent)
    },
    [onChange]
  )

  const { editor, replaceContent } = useBlockNote({
    initialMarkdown: content,
    onChange: wrappedOnChange
  })
  const isDark = useIsDark()

  // Sync content only for external changes (e.g., file reload from disk)
  useEffect(() => {
    if (content !== prevContentRef.current) {
      if (isLocalChangeRef.current) {
        // This change came from the editor itself, don't push it back
        isLocalChangeRef.current = false
      } else {
        // External change - replace editor content
        replaceContent(content)
      }
      prevContentRef.current = content
    }
  }, [content, replaceContent])

  return (
    <div
      className="w-full h-full overflow-auto"
      style={{ display: isVisible ? 'block' : 'none' }}
    >
      <BlockNoteViewRaw
        editor={editor}
        theme={isDark ? 'dark' : 'light'}
        formattingToolbar={false}
        linkToolbar={false}
        slashMenu={false}
        emojiPicker={false}
        sideMenu={false}
        filePanel={false}
        tableHandles={false}
      />
    </div>
  )
}
