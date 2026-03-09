import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import type { ImperativePanelGroupHandle, PanelOnResize } from 'react-resizable-panels'
import { useCodeMirror, type VisibleLineRange } from '@/hooks/use-codemirror'
import { TocPanel } from './TocPanel'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { useTocIsVisible, useTocWidth, useTocSettingsStore } from '@/stores/toc-settings-store'
import { TOC_MAX_WIDTH, TOC_MIN_WIDTH } from '@/types/settings'

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
  const layoutRef = useRef<HTMLDivElement>(null)
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null)
  const [visibleRange, setVisibleRange] = useState<VisibleLineRange | undefined>()
  const [layoutWidth, setLayoutWidth] = useState(0)
  const isTocVisible = useTocIsVisible()
  const tocWidth = useTocWidth()
  const setTocWidth = useTocSettingsStore((state) => state.setWidth)

  const { view, setContent, scrollToLine } = useCodeMirror(containerRef, {
    content,
    language,
    readOnly,
    onChange,
    onCursorChange,
    onScrollChange,
    onVisibleRangeChange: setVisibleRange
  })

  const getTocPanelSizePercent = useCallback((): number => {
    const panelWidth = layoutWidth || layoutRef.current?.clientWidth || 1000
    const widthRatio = panelWidth > 0 ? tocWidth / panelWidth : 0
    return Math.min(40, Math.max(10, widthRatio * 100))
  }, [layoutWidth, tocWidth])

  const tocPanelDefaultSize = useMemo(() => getTocPanelSizePercent(), [getTocPanelSizePercent])

  const handleTocResize = useCallback<PanelOnResize>(
    (size, prevSize): void => {
      const layoutWidth = layoutRef.current?.clientWidth ?? 1000
      const nextPixels = Math.round((size / 100) * layoutWidth)

      if (prevSize !== size) {
        setTocWidth(nextPixels)
      }
    },
    [setTocWidth]
  )

  // Update content when it changes from external source (file reload)
  const prevContentRef = useRef(content)
  useEffect(() => {
    if (content !== prevContentRef.current) {
      setContent(content)
      prevContentRef.current = content
    }
  }, [content, setContent])

  useEffect(() => {
    const element = layoutRef.current
    if (!element) {
      return
    }

    const updateLayoutWidth = (): void => {
      setLayoutWidth(element.clientWidth)
    }

    updateLayoutWidth()

    const observer = new ResizeObserver(() => {
      updateLayoutWidth()
    })

    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  // Focus when becoming visible
  useEffect(() => {
    if (isVisible && view) {
      view.focus()
    }
  }, [isVisible, view])

  useEffect(() => {
    if (!isTocVisible || language !== 'markdown') {
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
  }, [getTocPanelSizePercent, isTocVisible, language])

  return (
    <div className="h-full w-full" style={{ display: isVisible ? 'block' : 'none' }}>
      <div ref={layoutRef} className="h-full w-full">
        <ResizablePanelGroup ref={panelGroupRef} direction="horizontal">
          <ResizablePanel
            defaultSize={isTocVisible && language === 'markdown' ? 100 - tocPanelDefaultSize : 100}
            minSize={60}
          >
            <div ref={containerRef} className="w-full h-full overflow-hidden" />
          </ResizablePanel>

          {isTocVisible && language === 'markdown' && (
            <>
              <ResizableHandle />
              <ResizablePanel
                defaultSize={tocPanelDefaultSize}
                minSize={10}
                maxSize={40}
                onResize={handleTocResize}
              >
                <div
                  className="h-full"
                  style={{ minWidth: TOC_MIN_WIDTH, maxWidth: TOC_MAX_WIDTH, width: '100%' }}
                >
                  <TocPanel
                    editorMode="codemirror"
                    codemirror={{
                      content,
                      scrollToLine,
                      visibleRange
                    }}
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
