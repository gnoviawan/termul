import type { CodexUsageWindow } from '@shared/types/codex-accounts.types'
import { UsageBar } from '@/components/settings/provider/account-status'
import {
  codexBarWindow,
  codexWindowLabel,
  formatUsageReset,
  usageTone
} from '@/lib/codex-usage-format'
import { cn } from '@/lib/utils'
import { PERCENT_TEXT } from './account-status'

function valueText(window: CodexUsageWindow): string {
  const reset = formatUsageReset(window.resetsAt)
  return reset
    ? `${Math.round(window.percent)}% used, ${reset}`
    : `${Math.round(window.percent)}% used`
}

/** 5-hour and weekly bars for one Codex Account. */
export function CodexUsageMeters({
  windows
}: {
  windows: readonly CodexUsageWindow[]
}): React.JSX.Element | null {
  if (windows.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {windows.map((window) => {
        const label = codexWindowLabel(window)
        const reset = formatUsageReset(window.resetsAt)
        const tone = usageTone(window.percent)
        return (
          <div key={window.kind} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5 text-2xs">
              <span
                className={cn(
                  'font-medium',
                  tone === 'critical' ? 'text-destructive' : 'text-secondary-foreground'
                )}
              >
                {tone === 'critical' ? `${label} limit reached` : label}
              </span>
              <span className={cn('ml-auto font-semibold tabular-nums', PERCENT_TEXT[tone])}>
                {Math.round(window.percent)}%
              </span>
              {reset && <span className="text-muted-foreground">{reset}</span>}
            </div>
            <UsageBar
              window={codexBarWindow(window)}
              label={`${label} usage`}
              valueText={valueText(window)}
            />
          </div>
        )
      })}
    </div>
  )
}
