import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBlockNoteActiveHeading, useCodeMirrorActiveHeading } from '@/hooks/use-active-heading'
import type { VisibleLineRange } from '@/hooks/use-codemirror'
import { filterTocHeadings, parseMarkdownHeadings, type TocHeading } from '@/hooks/use-toc-headings'
import { useTocCollapsedKeys, useTocSettingsStore } from '@/stores/toc-settings-store'
import { OutlineTickStrip } from './outline/OutlineTickStrip'
import { useScrollProgress } from './outline/use-scroll-progress'
import { TableOfContents } from './TableOfContents'

/** Quiet time after the last scroll event that ends a TOC jump. */
const SETTLE_MS = 180

/** `panel`: side panel. `strip`: narrow-pane tick strip with a popover. */
export type TocVariant = 'panel' | 'strip'

interface BlockNoteTocApi {
  headings: TocHeading[]
  scrollToBlock: (blockId: string) => void
}

interface CodeMirrorTocApi {
  content: string
  scrollToLine: (lineNumber: number) => void
  visibleRange?: VisibleLineRange
  /** CodeMirror scroller (`view.scrollDOM`), for read progress. */
  scrollElement: HTMLElement | null
  /** True until the CodeMirror view is ready. */
  isLoading: boolean
}

type TocPanelProps = {
  /** Collapse state is kept per file. */
  filePath: string
  variant: TocVariant
} & (
  | {
      editorMode: 'blocknote'
      blocknote: BlockNoteTocApi
      container: HTMLElement | null
    }
  | {
      editorMode: 'codemirror'
      codemirror: CodeMirrorTocApi
    }
)

export function TocPanel(props: TocPanelProps): React.JSX.Element | null {
  return props.editorMode === 'blocknote' ? (
    <BlockNoteToc
      filePath={props.filePath}
      variant={props.variant}
      blocknote={props.blocknote}
      container={props.container}
    />
  ) : (
    <CodeMirrorToc
      filePath={props.filePath}
      variant={props.variant}
      codemirror={props.codemirror}
    />
  )
}

function BlockNoteToc({
  filePath,
  variant,
  blocknote,
  container
}: {
  filePath: string
  variant: TocVariant
  blocknote: BlockNoteTocApi
  container: HTMLElement | null
}): React.JSX.Element | null {
  const headings = useDepthFilteredHeadings(blocknote.headings)
  const scrollActiveHeadingId = useBlockNoteActiveHeading({ headings, container })
  const { scrollToBlock } = blocknote
  const jumpTo = useCallback(
    (heading: TocHeading) => {
      if (heading.blockId) scrollToBlock(heading.blockId)
    },
    [scrollToBlock]
  )

  return (
    <TocView
      filePath={filePath}
      variant={variant}
      headings={headings}
      hiddenCount={blocknote.headings.length - headings.length}
      isLoading={false}
      scrollActiveHeadingId={scrollActiveHeadingId}
      scrollElement={container}
      contentKey={headings.length}
      jumpTo={jumpTo}
    />
  )
}

function CodeMirrorToc({
  filePath,
  variant,
  codemirror
}: {
  filePath: string
  variant: TocVariant
  codemirror: CodeMirrorTocApi
}): React.JSX.Element | null {
  const { content, scrollToLine, visibleRange, scrollElement, isLoading } = codemirror
  const allHeadings = useMemo(() => parseMarkdownHeadings(content), [content])
  const headings = useDepthFilteredHeadings(allHeadings)
  const scrollActiveHeadingId = useCodeMirrorActiveHeading({ headings, visibleRange })
  const jumpTo = useCallback(
    (heading: TocHeading) => {
      if (heading.line) scrollToLine(heading.line)
    },
    [scrollToLine]
  )

  return (
    <TocView
      filePath={filePath}
      variant={variant}
      headings={headings}
      hiddenCount={allHeadings.length - headings.length}
      isLoading={isLoading}
      scrollActiveHeadingId={scrollActiveHeadingId}
      scrollElement={scrollElement}
      contentKey={content}
      jumpTo={jumpTo}
    />
  )
}

function useDepthFilteredHeadings(allHeadings: TocHeading[]): TocHeading[] {
  const maxHeadingLevel = useTocSettingsStore((state) => state.settings.maxHeadingLevel)
  return useMemo(
    () => filterTocHeadings(allHeadings, maxHeadingLevel),
    [allHeadings, maxHeadingLevel]
  )
}

/**
 * A clicked heading stays active while the jump scrolls, and also when the
 * document cannot scroll far enough to bring it to the top (the last
 * headings). The next scroll the user makes hands control back to the
 * scroll position. With no scroller there is nothing to release the hold,
 * so nothing is held.
 */
function useClickedHeading(scrollElement: HTMLElement | null): {
  clickedHeadingId: string | undefined
  holdHeading: (headingId: string) => void
} {
  const [clickedHeadingId, setClickedHeadingId] = useState<string | undefined>()
  const isSettlingRef = useRef(false)

  useEffect(() => {
    if (!clickedHeadingId || !scrollElement) {
      return
    }
    let timer = window.setTimeout(() => {
      isSettlingRef.current = false
    }, SETTLE_MS * 2)
    const handleScroll = (): void => {
      if (!isSettlingRef.current) {
        setClickedHeadingId(undefined)
        return
      }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        isSettlingRef.current = false
      }, SETTLE_MS)
    }
    scrollElement.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.clearTimeout(timer)
      scrollElement.removeEventListener('scroll', handleScroll)
    }
  }, [scrollElement, clickedHeadingId])

  const holdHeading = useCallback((headingId: string) => {
    isSettlingRef.current = true
    setClickedHeadingId(headingId)
  }, [])

  return { clickedHeadingId: scrollElement ? clickedHeadingId : undefined, holdHeading }
}

interface TocViewProps {
  filePath: string
  variant: TocVariant
  /** Headings at or above the depth setting. */
  headings: TocHeading[]
  hiddenCount: number
  isLoading: boolean
  scrollActiveHeadingId: string | undefined
  scrollElement: HTMLElement | null
  /** Changes when the document content changes, to re-read scroll progress. */
  contentKey: unknown
  jumpTo: (heading: TocHeading) => void
}

function TocView({
  filePath,
  variant,
  headings,
  hiddenCount,
  isLoading,
  scrollActiveHeadingId,
  scrollElement,
  contentKey,
  jumpTo
}: TocViewProps): React.JSX.Element | null {
  const maxHeadingLevel = useTocSettingsStore((state) => state.settings.maxHeadingLevel)
  const setMaxHeadingLevel = useTocSettingsStore((state) => state.setMaxHeadingLevel)
  const toggleVisibility = useTocSettingsStore((state) => state.toggleVisibility)
  const toggleCollapsedKey = useTocSettingsStore((state) => state.toggleCollapsedKey)
  const setCollapsedKeys = useTocSettingsStore((state) => state.setCollapsedKeys)
  const collapsedKeys = useTocCollapsedKeys(filePath)
  const { clickedHeadingId, holdHeading } = useClickedHeading(scrollElement)
  const { progress, scrollToTop } = useScrollProgress(
    variant === 'panel' ? scrollElement : null,
    contentKey
  )

  const activeHeadingId = clickedHeadingId ?? scrollActiveHeadingId

  const handleHeadingClick = (heading: TocHeading): void => {
    holdHeading(heading.id)
    jumpTo(heading)
  }

  const handleToggleCollapsed = useCallback(
    (key: string) => toggleCollapsedKey(filePath, key),
    [filePath, toggleCollapsedKey]
  )
  const handleCollapsedKeysChange = useCallback(
    (keys: string[]) => setCollapsedKeys(filePath, keys),
    [filePath, setCollapsedKeys]
  )

  if (variant === 'strip') {
    return (
      <OutlineTickStrip
        headings={headings}
        activeHeadingId={activeHeadingId}
        onHeadingClick={handleHeadingClick}
      />
    )
  }

  return (
    <TableOfContents
      headings={headings}
      hiddenCount={hiddenCount}
      isLoading={isLoading}
      activeHeadingId={activeHeadingId}
      maxHeadingLevel={maxHeadingLevel}
      collapsedKeys={collapsedKeys}
      progress={progress}
      onHeadingClick={handleHeadingClick}
      onMaxHeadingLevelChange={setMaxHeadingLevel}
      onToggleCollapsed={handleToggleCollapsed}
      onCollapsedKeysChange={handleCollapsedKeysChange}
      onHide={toggleVisibility}
      onScrollToTop={scrollToTop}
    />
  )
}
