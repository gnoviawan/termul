import { ChevronDown, ChevronsDownUp, PanelRight } from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  FOCUS_RING_CLASS,
  QUIET_ICON_BUTTON_CLASS,
  SEGMENTED_TRACK_CLASS
} from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { formatDepthLabel } from './outline-rows'

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const

interface OutlineDepthMenuProps {
  maxHeadingLevel: number
  onMaxHeadingLevelChange: (level: number) => void
  /** Shown when the outline has parents that are not all collapsed. */
  canCollapseAll: boolean
  /** Shown when at least one parent is collapsed. */
  canExpandAll: boolean
  onCollapseAll: () => void
  onExpandAll: () => void
  onHide: () => void
}

export function OutlineDepthMenu({
  maxHeadingLevel,
  onMaxHeadingLevelChange,
  canCollapseAll,
  canExpandAll,
  onCollapseAll,
  onExpandAll,
  onHide
}: OutlineDepthMenuProps): React.JSX.Element {
  const depthLabel = formatDepthLabel(maxHeadingLevel)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            QUIET_ICON_BUTTON_CLASS,
            'h-6 gap-1 px-2 text-2xs font-medium data-[state=open]:text-foreground'
          )}
          aria-label={`Heading depth ${depthLabel}`}
          title="Outline depth"
        >
          <span className="tabular-nums">{depthLabel}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 pb-1.5 pt-1.5 text-xs text-muted-foreground">
          Show headings down to
        </div>
        <div
          role="radiogroup"
          aria-label="Show headings down to"
          className={cn(SEGMENTED_TRACK_CLASS, 'mx-1 mb-1 h-7 bg-background')}
        >
          {HEADING_LEVELS.map((level) => {
            const isActive = level === maxHeadingLevel
            return (
              // biome-ignore lint/a11y/useSemanticElements: segmented track, not a native radio input
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => onMaxHeadingLevelChange(level)}
                className={cn(
                  'flex h-6 flex-1 items-center justify-center rounded-md text-xs font-medium tabular-nums transition-colors duration-150 ease-out',
                  FOCUS_RING_CLASS,
                  isActive && 'bg-foreground/10 text-foreground',
                  !isActive &&
                    (level < maxHeadingLevel
                      ? 'text-muted-foreground hover:text-foreground'
                      : 'text-muted-foreground/60 hover:text-foreground')
                )}
              >
                {`H${level}`}
              </button>
            )
          })}
        </div>
        <DropdownMenuSeparator />
        {canCollapseAll && (
          <DropdownMenuItem onSelect={onCollapseAll} className="gap-2">
            <ChevronsDownUp size={14} aria-hidden="true" />
            Collapse all
          </DropdownMenuItem>
        )}
        {canExpandAll && (
          <DropdownMenuItem onSelect={onExpandAll} className="gap-2">
            <ChevronDown size={14} aria-hidden="true" />
            Expand all
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onHide} className="gap-2">
          <PanelRight size={14} aria-hidden="true" />
          Hide outline
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
