import { memo, useMemo, useSyncExternalStore } from 'react'
import {
  getAgentById,
  getCustomAgentsCacheVersion,
  subscribeCustomAgentsCache
} from '@/lib/agents/custom-agents'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'

/**
 * Renders an agent's bundled SVG icon inline so `currentColor` inherits from
 * the parent's CSS text color — giving us theme-aware icons without any filter
 * hacks.
 *
 * Falls back to a letter-initial placeholder when the agent has no icon or the
 * agent ID can't be resolved.
 */

export interface AgentIconProps {
  agentId: string
  /** Optional display name (e.g. from terminal metadata for custom agents). */
  name?: string
  /** Optional pre-resolved icon markup (built-in or custom catalog SVG). */
  icon?: string
  /** Tailwind sizing class. Default: h-3.5 w-3.5 (tab-bar size). */
  className?: string
}

export const AgentIcon = memo(function AgentIcon({
  agentId,
  name,
  icon: iconProp,
  className = 'h-3.5 w-3.5'
}: AgentIconProps): React.JSX.Element {
  const customAgentsCacheVersion = useSyncExternalStore(
    subscribeCustomAgentsCache,
    getCustomAgentsCacheVersion,
    getCustomAgentsCacheVersion
  )

  const resolved = useMemo(() => {
    // Re-resolve when the custom-agent cache is refreshed after load/upsert.
    void customAgentsCacheVersion
    const def = getAgentById(agentId)
    const displayName = name ?? def?.name
    const rawIcon = iconProp ?? def?.icon
    const icon = rawIcon ? sanitizeInlineAgentSvg(rawIcon) : null
    return { displayName, icon }
  }, [agentId, customAgentsCacheVersion, iconProp, name])

  if (resolved.icon) {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex shrink-0 text-foreground/80 [&_svg]:h-full [&_svg]:w-full ${className}`}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: icon SVG is sanitized via sanitizeInlineAgentSvg (DOMPurify)
        dangerouslySetInnerHTML={{ __html: resolved.icon }}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-sm bg-foreground/10 text-[8px] font-semibold uppercase ${className}`}
    >
      {resolved.displayName?.charAt(0) ?? '?'}
    </span>
  )
})
