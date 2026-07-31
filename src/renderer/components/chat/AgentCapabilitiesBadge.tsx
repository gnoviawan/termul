import { FileText, Image as ImageIcon, Plug, Radio, Sparkles, Volume2 } from 'lucide-react'
import { useState } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'

export interface AgentCapabilitiesBadgeProps {
  image?: boolean
  audio?: boolean
  embeddedContext?: boolean
  mcpCapabilities?: { http?: boolean; sse?: boolean } | null
  className?: string
}

interface CapabilityItem {
  key: string
  label: string
  icon: typeof ImageIcon
}

/**
 * Compact, read-only summary of negotiated capabilities. Audio is shown as
 * advertised but explicitly marked unavailable until the composer can produce
 * its ACP content block.
 */
export function AgentCapabilitiesBadge({
  image = false,
  audio = false,
  embeddedContext = false,
  mcpCapabilities,
  className
}: AgentCapabilitiesBadgeProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const items: CapabilityItem[] = []
  if (image) items.push({ key: 'image', label: 'Image prompts', icon: ImageIcon })
  if (audio) {
    items.push({
      key: 'audio',
      label: 'Audio prompts (attachment unavailable)',
      icon: Volume2
    })
  }
  if (embeddedContext) {
    items.push({ key: 'embedded-context', label: 'Embedded files', icon: FileText })
  }
  if (mcpCapabilities?.http) items.push({ key: 'mcp-http', label: 'HTTP MCP', icon: Radio })
  if (mcpCapabilities?.sse) items.push({ key: 'mcp-sse', label: 'SSE MCP', icon: Plug })

  if (items.length === 0) return null

  const label = `Agent capabilities: ${items.map((item) => item.label).join(', ')}`

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-3xs font-medium text-muted-foreground',
            className
          )}
        >
          <Sparkles className="size-3" aria-hidden="true" />
          <span className="tabular-nums">{items.length}</span>
          <span className="sr-only">capabilities advertised</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72 space-y-2 p-3 text-xs">
        <p className="font-medium text-foreground">Agent capabilities</p>
        <ul className="space-y-1 text-muted-foreground">
          {items.map(({ key, label: itemLabel, icon: Icon }) => (
            <li key={key} className="flex items-center gap-1.5">
              <Icon className="size-3 shrink-0" aria-hidden="true" />
              <span>{itemLabel}</span>
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  )
}
