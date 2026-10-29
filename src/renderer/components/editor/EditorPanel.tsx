import { useCallback, useEffect, useState } from 'react'
import { useTocSettings } from '@/hooks/use-toc-settings'
import { textPreviewForPath } from '@/lib/editor-file-kind'
import { basename } from '@/lib/path-basename'
import type { TextFileState } from '@/stores/editor-store'
import { useEditorStore } from '@/stores/editor-store'
import { CodeEditor } from './CodeEditor'
import { EditorDraftConflictBanner } from './EditorDraftConflictBanner'
import { EditorToolbar } from './EditorToolbar'
import { MarkdownEditor } from './MarkdownEditor'
import { ImageViewer } from './media/ImageViewer'
import { PdfViewer } from './media/PdfViewer'
import { UnsupportedFileView } from './media/UnsupportedFileView'
import { VideoViewer } from './media/VideoViewer'
import { CHECKERBOARD_CLASS, ViewerLoading } from './media/viewer-chrome'

interface EditorPanelProps {
  filePath: string
  isVisible: boolean
}

export function EditorPanel({ filePath, isVisible }: EditorPanelProps): React.JSX.Element {
  // Intentionally invoked for side effects: loads and persists shared TOC settings.
  useTocSettings()

  const fileState = useEditorStore((state) => state.openFiles.get(filePath))

  if (!fileState) return <ViewerLoading />

  switch (fileState.kind) {
    case 'text':
      return <TextFilePanel file={fileState} isVisible={isVisible} />
    case 'image':
      return <ImageViewer filePath={filePath} revision={fileState.revision} />
    case 'video':
      return <VideoViewer filePath={filePath} revision={fileState.revision} />
    case 'pdf':
      return <PdfViewer filePath={filePath} revision={fileState.revision} />
    case 'unsupported':
      return <UnsupportedFileView filePath={filePath} unavailable={fileState} />
  }
}

function TextFilePanel({
  file,
  isVisible
}: {
  file: TextFileState
  isVisible: boolean
}): React.JSX.Element {
  const { filePath } = file
  const { updateContent, setViewMode, updateCursorPosition, updateScrollTop } =
    useEditorStore.getState()

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
    setViewMode(filePath, file.viewMode === 'preview' ? 'code' : 'preview')
  }, [filePath, file.viewMode, setViewMode])

  const preview = textPreviewForPath(filePath)
  const showPreview = preview !== null && file.viewMode === 'preview'
  // An unresolved draft conflict holds two stored buffers (disk + draft); no
  // edit may exist outside them, so the editor is locked until resolved.
  const isReadOnly = file.draftConflict !== undefined

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <EditorDraftConflictBanner filePath={filePath} />
      {preview && (
        <EditorToolbar
          viewMode={file.viewMode}
          onToggleViewMode={handleToggleViewMode}
          filePath={filePath}
        />
      )}
      <div className="flex-1 relative overflow-hidden">
        {showPreview && preview === 'markdown' ? (
          <MarkdownEditor
            filePath={filePath}
            content={file.content}
            isVisible={isVisible}
            readOnly={isReadOnly}
            onChange={handleChange}
          />
        ) : showPreview && preview === 'svg' ? (
          <SvgPreview filePath={filePath} content={file.content} />
        ) : (
          <CodeEditor
            filePath={filePath}
            content={file.content}
            language={file.language}
            readOnly={isReadOnly}
            isVisible={isVisible}
            initialCursorPosition={file.cursorPosition}
            initialScrollTop={file.scrollTop}
            onChange={handleChange}
            onCursorChange={handleCursorChange}
            onScrollChange={handleScrollChange}
          />
        )}
      </div>
    </div>
  )
}

/**
 * The live SVG buffer rendered as an `<img>` from a `blob:` URL. An `<img>`
 * never runs the SVG's scripts or loads its external resources, unlike
 * inlining the markup.
 */
function SvgPreview({
  filePath,
  content
}: {
  filePath: string
  content: string
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [content])

  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-background p-4">
      {url && (
        <img
          src={url}
          alt={basename(filePath)}
          draggable={false}
          className={`max-h-full max-w-full ${CHECKERBOARD_CLASS}`}
        />
      )}
    </div>
  )
}
