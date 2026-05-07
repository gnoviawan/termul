import { useState, useCallback, useEffect } from 'react'
import { CodeEditor } from './CodeEditor'
import { MarkdownEditor } from './MarkdownEditor'
import { EditorToolbar } from './EditorToolbar'
import { DiffViewer } from './DiffViewer'
import { useEditorStore } from '@/stores/editor-store'
import type { EditorFileState } from '@/stores/editor-store'
import { useTocSettings } from '@/hooks/use-toc-settings'
import { useGitFileStatusStore } from '@/stores/git-file-status-store'
import { gitApi } from '@/lib/tauri-git-api'
import { useActiveProject } from '@/stores/project-store'

interface EditorPanelProps {
  filePath: string
  isVisible: boolean
}

export function EditorPanel({
  filePath,
  isVisible
}: EditorPanelProps): React.JSX.Element {
  // Intentionally invoked for side effects: loads and persists shared TOC settings.
  useTocSettings()

  const [showDiff, setShowDiff] = useState(false)
  const [diffContent, setDiffContent] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)

  const fileState = useEditorStore(
    (state) => state.openFiles.get(filePath)
  ) as EditorFileState | undefined

  const gitStatus = useGitFileStatusStore(
    (state) => state.statusMap.get(filePath)
  )

  const activeProject = useActiveProject()

  const { updateContent, setViewMode, updateCursorPosition, updateScrollTop } =
    useEditorStore.getState()

  // Fetch diff when toggled on
  useEffect(() => {
    if (!showDiff || !activeProject?.path || !filePath) return

    let disposed = false
    setDiffLoading(true)
    setDiffContent('')

    gitApi.projectGitDiffFile(activeProject.path, filePath).then((diff) => {
      if (!disposed) {
        setDiffContent(diff)
        setDiffLoading(false)
      }
    }).catch(() => {
      if (!disposed) setDiffLoading(false)
    })

    return () => { disposed = true }
  }, [showDiff, activeProject?.path, filePath])

  // Reset diff when file changes
  useEffect(() => {
    setShowDiff(false)
    setDiffContent('')
  }, [filePath])

  const handleChange = useCallback(
    (content: string) => {
      updateContent(filePath, content)
    },
    [filePath, updateContent]
  )

  const handleCursorChange = useCallback(
    (line: number, col: number) => {
      updateCursorPosition(filePath, line, col)
    },
    [filePath, updateCursorPosition]
  )

  const handleScrollChange = useCallback(
    (scrollTop: number) => {
      updateScrollTop(filePath, scrollTop)
    },
    [filePath, updateScrollTop]
  )

  const handleToggleViewMode = useCallback(() => {
    if (!fileState) return
    const newMode = fileState.viewMode === 'markdown' ? 'code' : 'markdown'
    setViewMode(filePath, newMode)
  }, [filePath, fileState, setViewMode])

  const handleToggleDiff = useCallback(() => {
    setShowDiff((v) => !v)
  }, [])

  if (!fileState) {
    return (
      <div className="w-full h-full flex items-center justify-center text-muted-foreground">
        Loading...
      </div>
    )
  }

  const isMarkdownFile = fileState.language === 'markdown'
  const hasGitChanges = !!gitStatus

  // Show toolbar if: markdown file (always) OR any file with git changes
  const showToolbar = isMarkdownFile || hasGitChanges

  return (
    <div className="w-full h-full flex flex-col">
      {showToolbar && (
        <EditorToolbar
          viewMode={fileState.viewMode}
          onToggleViewMode={handleToggleViewMode}
          filePath={filePath}
          hasGitChanges={hasGitChanges}
          showDiff={showDiff}
          onToggleDiff={handleToggleDiff}
        />
      )}
      <div className="flex-1 relative overflow-hidden">
        {showDiff ? (
          diffLoading ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Loading diff...
            </div>
          ) : (
            <DiffViewer diff={diffContent} />
          )
        ) : isMarkdownFile && fileState.viewMode === 'markdown' ? (
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
