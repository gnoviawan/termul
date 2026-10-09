import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImperativePanelGroupHandle, PanelOnResize } from 'react-resizable-panels'
import { useShallow } from 'zustand/shallow'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useTocSettingsStore } from '@/stores/toc-settings-store'
import { TOC_MAX_WIDTH, TOC_MIN_WIDTH, TOC_NARROW_PANE_WIDTH } from '@/types/settings'
import type { TocVariant } from './TocPanel'

interface EditorTocLayoutProps {
  isVisible: boolean
  /** False when the file has no outline (a non-markdown source file). */
  hasOutline?: boolean
  /** The editor surface. It sits in a flex row, so give it `min-w-0 flex-1`. */
  children: React.ReactNode
  renderOutline: (variant: TocVariant) => React.ReactNode
}

function getTocPercentBounds(panelWidth: number): { minPercent: number; maxPercent: number } {
  const minPercent = (TOC_MIN_WIDTH / panelWidth) * 100
  const maxPercent = (TOC_MAX_WIDTH / panelWidth) * 100

  return {
    minPercent,
    maxPercent: Math.max(minPercent, maxPercent)
  }
}

/**
 * Editor beside its outline. The outline is a resizable side panel; on the
 * mobile web shell or in an editor pane under 720px the side panel would
 * squeeze the document, so the outline folds into a tick strip at the
 * right edge of the editor.
 */
export function EditorTocLayout({
  isVisible,
  hasOutline = true,
  children,
  renderOutline
}: EditorTocLayoutProps): React.JSX.Element {
  const layoutRef = useRef<HTMLDivElement>(null)
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null)
  const [layoutWidth, setLayoutWidth] = useState(0)
  const { isTocHydrated, isTocVisible, tocWidth, setTocWidth } = useTocSettingsStore(
    useShallow((state) => ({
      isTocHydrated: state.isLoaded || state.loadFailed,
      isTocVisible: state.settings.isVisible,
      tocWidth: state.settings.width,
      setTocWidth: state.setWidth
    }))
  )
  const isMobileWebShell = useMobileWebShell()

  const isNarrowPane = layoutWidth > 0 && layoutWidth < TOC_NARROW_PANE_WIDTH
  const isOutlineOn = hasOutline && isTocHydrated && isTocVisible
  const variant: TocVariant | null = !isOutlineOn
    ? null
    : isMobileWebShell || isNarrowPane
      ? 'strip'
      : 'panel'

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

  useEffect(() => {
    const element = layoutRef.current
    if (!element) {
      return
    }

    setLayoutWidth(element.clientWidth)
    const observer = new ResizeObserver(() => {
      setLayoutWidth(element.clientWidth)
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  const isPanel = variant === 'panel'
  useEffect(() => {
    if (!isPanel) {
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
  }, [isPanel, getTocPanelSizePercent])

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
          <ResizablePanel defaultSize={isPanel ? 100 - tocPanelDefaultSize : 100} minSize={60}>
            <div className="flex h-full w-full">
              {children}
              {variant === 'strip' && renderOutline('strip')}
            </div>
          </ResizablePanel>

          {isPanel && (
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
                  {renderOutline('panel')}
                </div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
