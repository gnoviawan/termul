import { ArrowUp } from '@/components/icons'
import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'

interface OutlineFooterProps {
  percent: number
  onScrollToTop: () => void
}

export function OutlineFooter({ percent, onScrollToTop }: OutlineFooterProps): React.JSX.Element {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-t border-border pl-4 pr-2">
      <div className="flex items-center gap-2">
        <div
          role="progressbar"
          aria-label="Read progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-[3px] w-14 overflow-hidden rounded-full bg-border"
        >
          <div
            className="h-full rounded-full bg-muted-foreground"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-2xs text-muted-foreground tabular-nums">{`${percent}% read`}</span>
      </div>
      <button
        type="button"
        onClick={onScrollToTop}
        className={cn(QUIET_ICON_BUTTON_CLASS, 'h-6 gap-1 px-1.5 text-2xs')}
        aria-label="Scroll to top"
      >
        <ArrowUp size={12} aria-hidden="true" />
        Top
      </button>
    </div>
  )
}
