import { AlertCircle, X } from '@/components/icons'
import { cn } from '@/lib/utils'
import { isNearLimit, useClaudeLimit, windowName } from './use-claude-limit'

/**
 * Strip inside the composer card for a Claude chat near its Account's limit
 * (from 80%), with the offer to switch to the Account with the most room.
 * `atTop` rounds the strip to the card's top corners when nothing sits above it.
 */
export function ClaudeLimitWarning({
  sessionId,
  atTop
}: {
  sessionId: string
  atTop: boolean
}): React.JSX.Element | null {
  const state = useClaudeLimit(sessionId)
  if (!state || !isNearLimit(state.limit)) return null

  const { limit, name, reset, switchTo, dismiss } = state
  const best = state.ctx.alternatives[0]
  return (
    <div
      role="status"
      data-testid="claude-limit-warning"
      className={cn(
        'flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-3.5 py-1.5 text-2xs text-warning',
        atTop && 'rounded-t-[15px]'
      )}
    >
      <AlertCircle size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {name} has used {Math.round(limit.percent ?? 80)}% of its {windowName(limit)} limit
        {reset ? ` · ${reset}` : ''}.
      </span>
      {best && (
        <button
          type="button"
          onClick={() => void switchTo(best)}
          className="shrink-0 font-medium underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          Switch to {best.account.name}
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded text-warning/80 hover:text-warning focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      >
        <X size={12} />
      </button>
    </div>
  )
}
