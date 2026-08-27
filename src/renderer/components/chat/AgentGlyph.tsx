import { Bot } from 'lucide-react'
import { useMemo } from 'react'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import { cn } from '@/lib/utils'

/**
 * Renders an ACP agent's icon (theme-adaptive inline SVG via `currentColor`).
 * Resolution precedence: `icon` prop (persisted custom SVG, bundled or
 * uploaded) → `findBundledIconByKey(`acp:${templateId}`)` (registry catalog) →
 * lucide `<Bot>` fallback.
 *
 * Used by every chat-side surface (AgentBadge, ChatHistoryEntryRow,
 * ProjectChatList, ChatEmptyState, ChatInputBar) — the single chokepoint for
 * ACP agent icons in the chat UI.
 */
export function AgentGlyph({
  templateId,
  icon,
  size = 14,
  className
}: {
  templateId: string | null
  /** Persisted custom icon SVG (bundled or uploaded). Takes precedence. */
  icon?: string | null
  size?: number
  className?: string
}): React.JSX.Element {
  const normalized = useMemo(() => {
    if (icon) {
      const sanitized = sanitizeInlineAgentSvg(icon)
      if (sanitized) return sanitized
    }
    if (!templateId) return null
    const svg = findBundledIconByKey(`acp:${templateId}`)?.svg
    return svg ? sanitizeInlineAgentSvg(svg) : null
  }, [icon, templateId])

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
