import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImperativePanelGroupHandle, PanelOnResize } from 'react-resizable-panels'
import { useShallow } from 'zustand/shallow'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useCodeMirror, type VisibleLineRange } from '@/hooks/use-codemirror'
import { useTocSettingsStore } from '@/stores/toc-settings-store'
import { TOC_MAX_WIDTH, TOC_MIN_WIDTH } from '@/types/settings'
import { TocPanel } from './TocPanel'

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

function getTocPercentBounds(panelWidth: number): { minPercent: number; maxPercent: number } {
  const minPercent = (TOC_MIN_WIDTH / panelWidth) * 100
  const maxPercent = (TOC_MAX_WIDTH / panelWidth) * 100

  return {
    minPercent,
    maxPercent: Math.max(minPercent, maxPercent)
  }
}

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
  const containerRef = useRef<HTMLDivElement>(null)
  const lastAppliedLineRef = useRef<number | null>(null)
  const pendingRevealLineRef = useRef<number | null>(null)
  const pendingRevealTermRef = useRef<string | undefined>(undefined)
  const hasRestoredViewStateRef = useRef(false)
  const layoutRef = useRef<HTMLDivElement>(null)
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null)
  const [visibleRange, setVisibleRange] = useState<VisibleLineRange | undefined>()
  const [layoutWidth, setLayoutWidth] = useState(0)
  const { isTocHydrated, isTocVisible, tocWidth, setTocWidth } = useTocSettingsStore(
    useShallow((state) => ({
      isTocHydrated: state.isLoaded || state.loadFailed,
      isTocVisible: state.settings.isVisible,
      tocWidth: state.settings.width,
      setTocWidth: state.setWidth
    }))
  )

  const { view, setContent, scrollToLine, restoreViewState } = useCodeMirror(containerRef, {
    content,
    language,
    readOnly,
    onChange,
    onCursorChange,
    onScrollChange,
    onVisibleRangeChange: setVisibleRange
  })

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
  const canRenderToc = isTocHydrated && isTocVisible && language === 'markdown'

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

  // Update content when it changes from external source (file reload)
  const prevContentRef = useRef(content)
  useEffect(() => {
    if (content !== prevContentRef.current) {
      setContent(content)
      prevContentRef.current = content
    }
  }, [content, setContent])

  useEffect(() => {
    lastAppliedLineRef.current = null
    pendingRevealLineRef.current = null
    pendingRevealTermRef.current = undefined
    hasRestoredViewStateRef.current = false
  }, [])

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
    if (hasRestoredViewStateRef.current) {
      return
    }

    const initialLine = initialCursorPosition?.line
    const initialCol = initialCursorPosition?.col ?? 1

    if (!initialLine) {
      return
    }

    // Intentionally wait until the editor is visible before restoring view state.
    // Hidden mounts don't have stable layout metrics yet; restoring too early can
    // misplace cursor/scroll. Keep `isVisible` in dependencies to retry when shown.
    if (!view || !isVisible) {
      return
    }

    restoreViewState(initialLine, initialCol, initialScrollTop)
    hasRestoredViewStateRef.current = true
    lastAppliedLineRef.current = initialLine
  }, [initialCursorPosition, initialScrollTop, isVisible, restoreViewState, view])

  useEffect(() => {
    const pending = (
      window as unknown as {
        __termulPendingRevealLine?: { filePath: string; lineNumber: number; searchTerm?: string }
      }
    ).__termulPendingRevealLine

    if (pending && pending.filePath === filePath && isVisible && view) {
      scrollToLine(pending.lineNumber, pending.searchTerm)
      lastAppliedLineRef.current = pending.lineNumber
      pendingRevealLineRef.current = null
      pendingRevealTermRef.current = undefined
      ;(window as unknown as { __termulPendingRevealLine?: unknown }).__termulPendingRevealLine =
        undefined
    }

    const handler = (event: Event): void => {
      const customEvent = event as CustomEvent<{
        filePath: string
        lineNumber: number
        searchTerm?: string
      }>
      if (!customEvent.detail) return
      if (customEvent.detail.filePath !== filePath) return

      if (!isVisible || !view) {
        pendingRevealLineRef.current = customEvent.detail.lineNumber
        pendingRevealTermRef.current = customEvent.detail.searchTerm
        return
      }

      scrollToLine(customEvent.detail.lineNumber, customEvent.detail.searchTerm)
      lastAppliedLineRef.current = customEvent.detail.lineNumber
      pendingRevealLineRef.current = null
      pendingRevealTermRef.current = undefined
    }

    window.addEventListener('termul:reveal-line', handler)
    return () => window.removeEventListener('termul:reveal-line', handler)
  }, [filePath, isVisible, scrollToLine, view])

  useEffect(() => {
    if (!isVisible || !view || pendingRevealLineRef.current == null) {
      return
    }

    scrollToLine(pendingRevealLineRef.current, pendingRevealTermRef.current)
    lastAppliedLineRef.current = pendingRevealLineRef.current
    pendingRevealLineRef.current = null
    pendingRevealTermRef.current = undefined
  }, [isVisible, scrollToLine, view])

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
          ? 'h-full w-full'
          : 'absolute inset-0 invisible pointer-events-none overflow-hidden'
      }
    >
      <div ref={layoutRef} className="h-full w-full">
        <ResizablePanelGroup ref={panelGroupRef} direction="horizontal">
          <ResizablePanel defaultSize={canRenderToc ? 100 - tocPanelDefaultSize : 100} minSize={60}>
            <div ref={containerRef} className="w-full h-full overflow-hidden" />
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
