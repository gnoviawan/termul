import { Plug } from 'lucide-react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'

interface McpBadgeProps {
  /** Number of MCP servers attached to this session (v1: the global count). */
  count: number
  className?: string
}

/**
 * Read-only MCP badge shown in the composer (Story 1.8 AC1: "read-only badge
 * in composer for v1; edit via New Chat"). Hidden when no MCP servers are
 * attached. The hover tooltip clarifies that per-session MCP attach is done
 * via the New Chat flow (v1 does not inline-edit MCP from the composer).
 */
export function McpBadge({ count, className }: McpBadgeProps): React.JSX.Element | null {
  if (count <= 0) return null
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-3xs font-medium text-muted-foreground',
            className
          )}
        >
          <Plug className="size-3" aria-hidden="true" />
          <span className="tabular-nums">{count}</span>
          <span className="sr-only">MCP servers attached</span>
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-56 space-y-1 p-3 text-xs">
        <p className="font-medium text-foreground">MCP servers</p>
        <p className="text-muted-foreground">{count} attached to this session.</p>
        <p className="text-3xs text-muted-foreground/80">
          Attach or remove MCP servers via the New Chat flow (v1 — read-only here).
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}
