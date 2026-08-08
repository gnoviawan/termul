import { Bot } from 'lucide-react'
import { useMemo } from 'react'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import { cn } from '@/lib/utils'

/**
 * Renders an ACP agent's bundled registry icon (theme-adaptive inline SVG via
 * `currentColor`) resolved by template id. Falls back to a generic bot glyph
 * when the template has no bundled icon (e.g. a custom agent or unresolved id).
 *
 * Uses the same bundled icon catalog as the agent launcher so every configured
 * registry agent renders its real CLI icon, not just a hardcoded subset.
 */
export function AgentGlyph({
  templateId,
  size = 14,
  className
}: {
  templateId: string | null
  size?: number
  className?: string
}): React.JSX.Element {
  const normalized = useMemo(() => {
    if (!templateId) return null
    const svg = findBundledIconByKey(`acp:${templateId}`)?.svg
    return svg ? sanitizeInlineAgentSvg(svg) : null
  }, [templateId])

  if (normalized) {
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size }}
        className={cn(
          'inline-flex shrink-0 text-foreground/80 [&_svg]:h-full [&_svg]:w-full',
          className
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: icon SVG is sanitized via sanitizeInlineAgentSvg (DOMPurify)
        dangerouslySetInnerHTML={{ __html: normalized }}
      />
    )
  }
  return <Bot size={size} className={cn('shrink-0 text-foreground/80', className)} />
}
