import { BlockNoteViewRaw } from '@blocknote/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImperativePanelGroupHandle, PanelOnResize } from 'react-resizable-panels'
import { useShallow } from 'zustand/shallow'
import { FrontmatterProperties } from '@/components/editor/FrontmatterProperties'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
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
import { useTocSettingsStore } from '@/stores/toc-settings-store'
import { TOC_MAX_WIDTH, TOC_MIN_WIDTH } from '@/types/settings'
import { TocPanel } from './TocPanel'
import '@blocknote/react/style.css'

interface MarkdownEditorProps {
  filePath: string
  content: string
  isVisible: boolean
  onChange: (content: string) => void
}

function getTocPercentBounds(panelWidth: number): { minPercent: number; maxPercent: number } {
  const minPercent = (TOC_MIN_WIDTH / panelWidth) * 100
  const maxPercent = (TOC_MAX_WIDTH / panelWidth) * 100

  return {
    minPercent,
    maxPercent: Math.max(minPercent, maxPercent)
  }
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
    getHeadings,
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
  const layoutRef = useRef<HTMLDivElement>(null)
  const blockNoteScrollRootRef = useRef<HTMLDivElement>(null)
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null)
  const [blockNoteContainer, setBlockNoteContainer] = useState<HTMLDivElement | null>(null)
  const [layoutWidth, setLayoutWidth] = useState(0)
  const { isTocHydrated, isTocVisible, tocWidth, setTocWidth } = useTocSettingsStore(
    useShallow((state) => ({
      isTocHydrated: state.isLoaded || state.loadFailed,
      isTocVisible: state.settings.isVisible,
      tocWidth: state.settings.width,
      setTocWidth: state.setWidth
    }))
  )

  const getPanelWidth = useCallback((): number => {
    return layoutWidth || layoutRef.current?.clientWidth || 1000
  }, [layoutWidth])

  const getTocPanelSizePercent = useCallback((): number => {
    const panelWidth = getPanelWidth()
    const { minPercent, maxPercent } = getTocPercentBounds(panelWidth)
    const widthRatio = panelWidth > 0 ? tocWidth / panelWidth : 0

    return Math.min(maxPercent, Math.max(minPercent, widthRatio * 100))
  }, [getPanelWidth, tocWidth])

  const tocPanelBounds = useMemo(() => getTocPercentBounds(getPanelWidth()), [getPanelWidth])
  const tocPanelDefaultSize = useMemo(() => getTocPanelSizePercent(), [getTocPanelSizePercent])
  const canRenderToc = isTocHydrated && isTocVisible

  const handleTocResize = useCallback<PanelOnResize>(
    (size, prevSize): void => {
      const panelWidth = getPanelWidth()
      const { minPercent, maxPercent } = getTocPercentBounds(panelWidth)
      const clampedSize = Math.min(maxPercent, Math.max(minPercent, size))
      const nextPixels = Math.round((clampedSize / 100) * panelWidth)

      if (prevSize !== size) {
        setTocWidth(nextPixels)
      }
    },
    [getPanelWidth, setTocWidth]
  )

  // Sync content only for external changes (e.g., file reload from disk)
  useEffect(() => {
    if (filePath !== prevFilePathRef.current) {
      pendingLocalEmitsRef.current = 0
      prevFilePathRef.current = filePath
      prevContentRef.current = content
      applyExternalContent(content)
      return
    }

    if (content !== prevContentRef.current) {
      if (pendingLocalEmitsRef.current > 0) {
        pendingLocalEmitsRef.current -= 1
      } else {
        applyExternalContent(content)
      }
      prevContentRef.current = content
    }
  }, [applyExternalContent, content, filePath])

  useEffect(() => {
    setBlockNoteContainer(blockNoteScrollRootRef.current)
  }, [])

  useEffect(() => {
    const element = layoutRef.current
    if (!element) {
      return
    }

    const updateLayoutWidth = (): void => {
      setLayoutWidth(element.clientWidth)
      setBlockNoteContainer(blockNoteScrollRootRef.current)
    }

    updateLayoutWidth()

    const observer = new ResizeObserver(() => {
      updateLayoutWidth()
    })

    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!canRenderToc) {
      return
    }

    const group = panelGroupRef.current
    if (!group) {
      return
    }

    const tocSize = getTocPanelSizePercent()
    const currentTocSize = group.getLayout()[1]

    if (currentTocSize !== undefined && Math.abs(currentTocSize - tocSize) < 0.5) {
      return
    }

    group.setLayout([100 - tocSize, tocSize])
  }, [canRenderToc, getTocPanelSizePercent])

  return (
    <div
      className={
        isVisible
          ? 'w-full h-full'
          : 'absolute inset-0 invisible pointer-events-none overflow-hidden'
      }
    >
      <div ref={layoutRef} className="h-full w-full">
        <ResizablePanelGroup ref={panelGroupRef} direction="horizontal">
          <ResizablePanel defaultSize={canRenderToc ? 100 - tocPanelDefaultSize : 100} minSize={60}>
            <div ref={blockNoteScrollRootRef} className="flex h-full flex-col overflow-auto">
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
          </ResizablePanel>

          {canRenderToc && (
            <>
              <ResizableHandle />
              <ResizablePanel
                defaultSize={tocPanelDefaultSize}
                minSize={tocPanelBounds.minPercent}
                maxSize={tocPanelBounds.maxPercent}
                onResize={handleTocResize}
              >
                <div
                  className="h-full"
                  style={{ minWidth: TOC_MIN_WIDTH, maxWidth: TOC_MAX_WIDTH, width: '100%' }}
                >
                  <TocPanel
                    editorMode="blocknote"
                    blocknote={{ getHeadings, scrollToBlock }}
                    container={blockNoteContainer}
                  />
                </div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
