import { useMemo } from 'react'
import { RefreshCw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import { formatUsageChecked } from '@/lib/claude-usage-format'

interface ProviderGroupHeaderProps {
  /** Bundled agent icon key, e.g. `acp:claude-acp`. */
  iconKey: string
  name: string
  /** Quiet text after the name, e.g. "2 accounts". */
  count?: string
  /** Oldest usage read in the group, epoch ms. */
  lastChecked: number | null
  refreshing: boolean
  /** Omit to hide the refresh control (nothing to refresh). */
  onRefresh?: () => void
  /** Extra action at the trailing edge (e.g. "Add account"). */
  action?: React.ReactNode
}

/** The heading of one provider's account group: brand mark, name, usage refresh. */
export function ProviderGroupHeader({
  iconKey,
  name,
  count,
  lastChecked,
  refreshing,
  onRefresh,
  action
}: ProviderGroupHeaderProps): React.JSX.Element {
  const svg = useMemo(() => {
    const entry = findBundledIconByKey(iconKey)
    return entry ? sanitizeInlineAgentSvg(entry.svg) : null
  }, [iconKey])

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-border/60 pb-3">
      {svg && (
        <span
          aria-hidden="true"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground/85 [&_svg]:size-3.5"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: bundled icon SVG sanitized via sanitizeInlineAgentSvg (DOMPurify)
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      <h3 className="text-sm font-semibold leading-none text-foreground">{name}</h3>
      {count && <span className="text-2xs text-muted-foreground">{count}</span>}
      <span
        className="ml-auto flex items-center gap-1.5 text-2xs text-muted-foreground"
        aria-live="polite"
      >
        {refreshing ? (
          <>
            <Spinner size={11} decorative />
            Updating…
          </>
        ) : lastChecked ? (
          formatUsageChecked(lastChecked)
        ) : null}
      </span>
      {onRefresh && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={`Refresh ${name} usage`}
          className="text-muted-foreground"
        >
          <RefreshCw size={13} />
        </Button>
      )}
      {action}
    </div>
  )
}

/** Oldest usage read, so "Updated …" never claims fresher data than it shows. */
export function oldestCheck(usage: Record<string, { checkedAt: number }>): number | null {
  const times = Object.values(usage).map((read) => read.checkedAt)
  return times.length > 0 ? Math.min(...times) : null
}
