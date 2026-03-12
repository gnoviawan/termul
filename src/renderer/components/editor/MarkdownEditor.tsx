import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { ImperativePanelGroupHandle, PanelOnResize } from 'react-resizable-panels'
import { useBlockNote } from '@/hooks/use-blocknote'
import { BlockNoteViewRaw } from '@blocknote/react'
import { TocPanel } from './TocPanel'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { useTocSettingsStore } from '@/stores/toc-settings-store'
import { TOC_MAX_WIDTH, TOC_MIN_WIDTH } from '@/types/settings'
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
  filePath,
  content,
  isVisible,
  onChange
}: MarkdownEditorProps): React.JSX.Element {
  // Track whether the last content change came from this editor's onChange
  const isLocalChangeRef = useRef(false)
  const prevContentRef = useRef(content)
  const prevFilePathRef = useRef(filePath)

  const wrappedOnChange = useCallback(
    (newContent: string) => {
      isLocalChangeRef.current = true
      prevContentRef.current = newContent
      onChange(newContent)
    },
    [onChange]
  )

  const { editor, replaceContent, getHeadings, scrollToBlock } = useBlockNote({
    initialMarkdown: content,
    onChange: wrappedOnChange
  })
  const isDark = useIsDark()
  const layoutRef = useRef<HTMLDivElement>(null)
  const blockNoteScrollRootRef = useRef<HTMLDivElement>(null)
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null)
  const [blockNoteContainer, setBlockNoteContainer] = useState<HTMLDivElement | null>(null)
  const [layoutWidth, setLayoutWidth] = useState(0)
  const { isTocHydrated, isTocVisible, tocWidth, setTocWidth } = useTocSettingsStore((state) => ({
    isTocHydrated: state.isLoaded || state.loadFailed,
    isTocVisible: state.settings.isVisible,
    tocWidth: state.settings.width,
    setTocWidth: state.setWidth
  }))

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
      isLocalChangeRef.current = false
      prevFilePathRef.current = filePath
      prevContentRef.current = content
      void replaceContent(content)
      return
    }

    if (content !== prevContentRef.current) {
      if (isLocalChangeRef.current) {
        // This change came from the editor itself, don't push it back
        isLocalChangeRef.current = false
      } else {
        // External change - replace editor content
        void replaceContent(content)
      }
      prevContentRef.current = content
    }
  }, [content, filePath, replaceContent])

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
    <div className="w-full h-full" style={{ display: isVisible ? 'block' : 'none' }}>
      <div ref={layoutRef} className="h-full w-full">
        <ResizablePanelGroup ref={panelGroupRef} direction="horizontal">
          <ResizablePanel defaultSize={canRenderToc ? 100 - tocPanelDefaultSize : 100} minSize={60}>
            <div ref={blockNoteScrollRootRef} className="h-full overflow-auto">
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
