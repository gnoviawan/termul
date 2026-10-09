import { BlockNoteViewRaw } from '@blocknote/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FrontmatterProperties } from '@/components/editor/FrontmatterProperties'
import { useBlockNote } from '@/hooks/use-blocknote'
import {
  registerEditorContentFlusher,
  unregisterEditorContentFlusher
} from '@/lib/editor-content-flush'
import {
  composeFullMarkdown,
  type FrontmatterMap,
  splitFrontmatter
} from '@/lib/markdown-frontmatter'
import { EditorTocLayout } from './EditorTocLayout'
import { TocPanel } from './TocPanel'
import '@blocknote/react/style.css'

interface MarkdownEditorProps {
  filePath: string
  content: string
  isVisible: boolean
  onChange: (content: string) => void
}

function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(document.documentElement.classList.contains('dark'))

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
  filePath,
  content,
  isVisible,
  onChange
}: MarkdownEditorProps): React.JSX.Element {
  // Count of local emits still awaiting acknowledgment from the content prop sync.
  const pendingLocalEmitsRef = useRef(0)
  const prevContentRef = useRef(content)
  const prevFilePathRef = useRef(filePath)
  // Bumped on external reload / file switch / unmount to cancel in-flight FM emits.
  const contentGenerationRef = useRef(0)

  const initialParsedRef = useRef(splitFrontmatter(content))
  const [hasFrontmatter, setHasFrontmatter] = useState(initialParsedRef.current.hasFrontmatter)
  const [frontmatter, setFrontmatter] = useState<FrontmatterMap>(initialParsedRef.current.data)
  const frontmatterRef = useRef(frontmatter)
  frontmatterRef.current = frontmatter
  const hasFrontmatterRef = useRef(hasFrontmatter)
  hasFrontmatterRef.current = hasFrontmatter
  const bodyRef = useRef(initialParsedRef.current.body)

  const emitFullContent = useCallback(
    (body: string) => {
      bodyRef.current = body
      const full = composeFullMarkdown(hasFrontmatterRef.current, frontmatterRef.current, body)
      // Serialize failure → keep last-good store content (muted).
      if (full === null) return

      pendingLocalEmitsRef.current += 1
      prevContentRef.current = full
      onChange(full)
    },
    [onChange]
  )

  const {
    editor,
    replaceContent,
    flushPendingContent,
    capturePendingContent,
    headings,
    scrollToBlock
  } = useBlockNote({
    filePath,
    initialMarkdown: initialParsedRef.current.body,
    onChange: emitFullContent
  })

  const flushFullContent = useCallback(async (): Promise<void> => {
    // Flush BlockNote body through emitFullContent so the store receives rejoined FM+body.
    await flushPendingContent()
  }, [flushPendingContent])

  useEffect(() => {
    registerEditorContentFlusher(filePath, flushFullContent)
    return () => unregisterEditorContentFlusher(filePath)
  }, [filePath, flushFullContent])

  const applyExternalContent = useCallback(
    (nextContent: string) => {
      contentGenerationRef.current += 1
      pendingLocalEmitsRef.current = 0
      const parsed = splitFrontmatter(nextContent)
      setHasFrontmatter(parsed.hasFrontmatter)
      setFrontmatter(parsed.data)
      frontmatterRef.current = parsed.data
      hasFrontmatterRef.current = parsed.hasFrontmatter
      bodyRef.current = parsed.body
      void replaceContent(parsed.body)
    },
    [replaceContent]
  )

  const handleFrontmatterChange = useCallback(
    (next: FrontmatterMap) => {
      frontmatterRef.current = next
      hasFrontmatterRef.current = true
      setFrontmatter(next)
      setHasFrontmatter(true)

      const generation = contentGenerationRef.current
      void (async () => {
        // Capture latest body without emitting, then emit exactly once with new FM.
        const captured = await capturePendingContent()
        if (generation !== contentGenerationRef.current) return
        if (captured !== null) {
          bodyRef.current = captured
        }
        emitFullContent(bodyRef.current)
      })()
    },
    [capturePendingContent, emitFullContent]
  )

  useEffect(() => {
    return () => {
      contentGenerationRef.current += 1
    }
  }, [])

  const isDark = useIsDark()
  // Callback ref: the outline observes the scroll root once it mounts.
  const [blockNoteContainer, setBlockNoteContainer] = useState<HTMLDivElement | null>(null)

  // Sync content only for external changes (e.g., file reload from disk)
  useEffect(() => {
    if (filePath !== prevFilePathRef.current) {
      pendingLocalEmitsRef.current = 0
      prevFilePathRef.current = filePath
      prevContentRef.current = content
      applyExternalContent(content)
      return
    }

    // Verbatim store echo of our emit: content already matches prevContentRef
    // (set in emitFullContent). Still clear pending so a later genuine external
    // update is not consumed as a leftover local emit.
    if (content === prevContentRef.current) {
      pendingLocalEmitsRef.current = 0
      return
    }

    // Distinct content → external. Never burn pending on a mismatch; that used
    // to drop real reloads after a same-content echo left the counter elevated.
    pendingLocalEmitsRef.current = 0
    applyExternalContent(content)
    prevContentRef.current = content
  }, [applyExternalContent, content, filePath])

  return (
    <EditorTocLayout
      isVisible={isVisible}
      renderOutline={(variant) => (
        <TocPanel
          variant={variant}
          filePath={filePath}
          editorMode="blocknote"
          blocknote={{ headings, scrollToBlock }}
          container={blockNoteContainer}
        />
      )}
    >
      <div
        ref={setBlockNoteContainer}
        className="markdown-editor flex h-full min-w-0 flex-1 flex-col overflow-auto"
      >
        <div className="markdown-editor-document flex min-h-full w-full flex-col">
          {hasFrontmatter && (
            <FrontmatterProperties data={frontmatter} onChange={handleFrontmatterChange} />
          )}
          <div className="min-h-0 flex-1">
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
        </div>
      </div>
    </EditorTocLayout>
  )
}
