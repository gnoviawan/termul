import { useMemo } from 'react'
import { PANEL_HEADER_CLASS } from '@/components/ui/panel-styles'
import type { TocHeading } from '@/hooks/use-toc-headings'
import { cn } from '@/lib/utils'
import { OutlineDepthMenu } from './outline/OutlineDepthMenu'
import { OutlineFooter } from './outline/OutlineFooter'
import { OutlineList } from './outline/OutlineList'
import { OutlineEmpty, OutlineHidden, OutlineSkeleton } from './outline/OutlineStates'
import { buildOutlineModel } from './outline/outline-rows'
import type { ScrollProgress } from './outline/use-scroll-progress'

const EMPTY_KEYS: readonly string[] = []

interface TableOfContentsProps {
  /** Headings at or above `maxHeadingLevel`. */
  headings: TocHeading[]
  /** Headings deeper than `maxHeadingLevel` (they do not show). */
  hiddenCount?: number
  /** True while the editor has not parsed the document yet. */
  isLoading?: boolean
  activeHeadingId?: string
  maxHeadingLevel: number
  collapsedKeys?: readonly string[]
  progress?: ScrollProgress
  onHeadingClick: (heading: TocHeading) => void
  onMaxHeadingLevelChange: (level: number) => void
  onToggleCollapsed: (key: string) => void
  onCollapsedKeysChange: (keys: string[]) => void
  onHide: () => void
  onScrollToTop: () => void
}

export function TableOfContents({
  headings,
  hiddenCount = 0,
  isLoading = false,
  activeHeadingId,
  maxHeadingLevel,
  collapsedKeys = EMPTY_KEYS,
  progress,
  onHeadingClick,
  onMaxHeadingLevelChange,
  onToggleCollapsed,
  onCollapsedKeysChange,
  onHide,
  onScrollToTop
}: TableOfContentsProps): React.JSX.Element {
  const model = useMemo(
    () => buildOutlineModel(headings, new Set(collapsedKeys)),
    [headings, collapsedKeys]
  )
  const collapsedParentCount = model.parentKeys.filter((key) => collapsedKeys.includes(key)).length
  const activeRowId = activeHeadingId ? model.visibleIdFor.get(activeHeadingId) : undefined

  const renderBody = (): React.JSX.Element => {
    if (isLoading) {
      return <OutlineSkeleton />
    }
    if (headings.length === 0) {
      return hiddenCount > 0 ? (
        <OutlineHidden
          hiddenCount={hiddenCount}
          maxHeadingLevel={maxHeadingLevel}
          onShowAll={() => onMaxHeadingLevelChange(6)}
        />
      ) : (
        <OutlineEmpty />
      )
    }
    return (
      <OutlineList
        rows={model.rows}
        activeRowId={activeRowId}
        onHeadingClick={onHeadingClick}
        onToggleCollapsed={onToggleCollapsed}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className={cn(PANEL_HEADER_CLASS, 'pr-2')}>
        <span className="label-panel">On this page</span>
        <OutlineDepthMenu
          maxHeadingLevel={maxHeadingLevel}
          onMaxHeadingLevelChange={onMaxHeadingLevelChange}
          canCollapseAll={collapsedParentCount < model.parentKeys.length}
          canExpandAll={collapsedParentCount > 0}
          onCollapseAll={() => onCollapsedKeysChange(model.parentKeys)}
          onExpandAll={() => onCollapsedKeysChange([])}
          onHide={onHide}
        />
      </div>

      {renderBody()}

      {!isLoading && headings.length > 0 && progress?.canScroll && (
        <OutlineFooter percent={progress.percent} onScrollToTop={onScrollToTop} />
      )}
    </div>
  )
}
