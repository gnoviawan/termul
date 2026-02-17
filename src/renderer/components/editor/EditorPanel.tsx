import { useCallback } from 'react'
import { CodeEditor } from './CodeEditor'
import { MarkdownEditor } from './MarkdownEditor'
import { EditorToolbar } from './EditorToolbar'
import { useEditorStore } from '@/stores/editor-store'
import type { EditorFileState } from '@/stores/editor-store'

interface EditorPanelProps {
  filePath: string
  isVisible: boolean
}

export function EditorPanel({
  filePath,
  isVisible
}: EditorPanelProps): React.JSX.Element {
  const fileState = useEditorStore(
    (state) => state.openFiles.get(filePath)
  ) as EditorFileState | undefined

  const { updateContent, setViewMode, updateCursorPosition, updateScrollTop } =
    useEditorStore.getState()

  const handleChange = useCallback(
    (content: string) => {
      updateContent(filePath, content)
    },
    [filePath]
  )

  const handleCursorChange = useCallback(
    (line: number, col: number) => {
      updateCursorPosition(filePath, line, col)
    },
    [filePath]
  )

  const handleScrollChange = useCallback(
    (scrollTop: number) => {
      updateScrollTop(filePath, scrollTop)
    },
    [filePath]
  )

  const handleToggleViewMode = useCallback(() => {
    if (!fileState) return
    const newMode = fileState.viewMode === 'markdown' ? 'code' : 'markdown'
    setViewMode(filePath, newMode)
  }, [filePath, fileState?.viewMode])

  if (!fileState) {
    return (
      <div className="w-full h-full flex items-center justify-center text-muted-foreground">
        Loading...
      </div>
    )
  }

  const isMarkdownFile = fileState.language === 'markdown'

  return (
    <div className="w-full h-full flex flex-col">
      {isMarkdownFile && (
        <EditorToolbar
          viewMode={fileState.viewMode}
          onToggleViewMode={handleToggleViewMode}
          filePath={filePath}
        />
      )}
      <div className="flex-1 relative overflow-hidden">
        {isMarkdownFile && fileState.viewMode === 'markdown' ? (
          <MarkdownEditor
            filePath={filePath}
            content={fileState.content}
            isVisible={isVisible}
            onChange={handleChange}
          />
        ) : (
          <CodeEditor
            filePath={filePath}
            content={fileState.content}
            language={fileState.language}
            isVisible={isVisible}
            onChange={handleChange}
            onCursorChange={handleCursorChange}
            onScrollChange={handleScrollChange}
          />
        )}
      </div>
    </div>
  )
}
