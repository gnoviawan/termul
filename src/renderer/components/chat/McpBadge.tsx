import { Plug, PlugZap } from 'lucide-react'
import { useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import type { McpToolInfo, ProbeStatus } from '@/lib/acp-api'
import { cn } from '@/lib/utils'

interface McpServerSummary {
  id: string
  name: string
  enabled?: boolean
}

interface McpBadgeProps {
  /** Number of MCP servers attached to this session (badge summary count). */
  count: number
  className?: string
  /**
   * Per-server enable/disable popover (chatbox). When omitted (or empty), the
   * badge degrades to the read-only count pill (backward-compat — no popover).
   * When provided with at least one server, the badge becomes a Popover that
   * lists each server with a status dot + enable/disable radio — discoverable
   * even when `count` is 0 (mirrors GH-287's `onManage` pattern).
   */
  servers?: McpServerSummary[]
  /** Toggle a server's `enabled` flag. Reuses `setMcpServerEnabled` (optimistic + rollback). */
  onToggle?: (id: string, enabled: boolean) => void
  /** Per-server probe status (Termul's own rmcp client connection, NOT the agent's). */
  probeStatus?: Record<string, ProbeStatus>
  /** Per-server cached `tools/list` output (for the collapsible tool list). */
  tools?: Record<string, McpToolInfo[]>
  /** Auto-probe on first expand of a server's tool list. */
  onLoadTools?: (id: string) => void
}

function statusColor(status: ProbeStatus | undefined): string {
  if (status === 'connected') return 'bg-connection'
  if (status === 'disconnected') return 'bg-destructive'
  return 'bg-muted-foreground/40'
}

/** Short visible status for the server row (pairs with the color dot). */
function statusShortLabel(status: ProbeStatus | undefined): string {
  if (status === 'connected') return 'Connected'
  if (status === 'disconnected') return 'Disconnected'
  return 'Not probed'
}

function statusLabel(status: ProbeStatus | undefined): string {
  if (status === 'connected') return 'Connected (Termul can reach this server)'
  if (status === 'disconnected') return 'Disconnected (Termul could not reach this server)'
  return 'Not probed yet — click to test'
}

/**
 * MCP badge in the composer. Read-only count pill by default; when `servers`
 * is provided, swaps to a Popover with per-server enable/disable + a
 * collapsible tool list. The probe reflects Termul's own client connection
 * (NOT the agent's — see the spec's Design Notes). Per-tool enable/disable is
 * deferred — UI shows the tool list read-only for awareness.
 */
export function McpBadge({
  count,
  className,
  servers,
  onToggle,
  probeStatus,
  tools,
  onLoadTools
}: McpBadgeProps): React.JSX.Element | null {
  const hasServerList = servers != null && servers.length > 0
  if (count <= 0 && !hasServerList) return null

  // Count-only pill (backward-compat — no server list passed).
  if (!hasServerList) {
    return (
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
    )
  }

  return (
    <McpPopover
      count={count}
      servers={servers!}
      onToggle={onToggle}
      probeStatus={probeStatus}
      tools={tools}
      onLoadTools={onLoadTools}
      className={className}
    />
  )
}

interface PopoverProps {
  count: number
  servers: McpServerSummary[]
  onToggle?: (id: string, enabled: boolean) => void
  probeStatus?: Record<string, ProbeStatus>
  tools?: Record<string, McpToolInfo[]>
  onLoadTools?: (id: string) => void
  className?: string
}

function McpPopover({
  count,
  servers,
  onToggle,
  probeStatus,
  tools,
  onLoadTools,
  className
}: PopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-3xs font-medium text-muted-foreground transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className
          )}
          aria-label={`MCP servers — ${count} attached. Click to manage per-server enable/disable.`}
        >
          <PlugZap className="size-3" aria-hidden="true" />
          <span className="tabular-nums">{count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3 text-xs">
        <p className="font-medium text-foreground">MCP servers</p>
        <p className="mt-0.5 text-muted-foreground">
          {count > 0 ? `${count} attached to this session.` : 'No servers attached yet.'}
        </p>
        <ul className="mt-2 space-y-2">
          {servers.map((server) => (
            <McpServerRow
              key={server.id}
              server={server}
              onToggle={onToggle}
              probeStatus={probeStatus?.[server.id]}
              tools={tools?.[server.id]}
              onLoadTools={onLoadTools}
            />
          ))}
        </ul>
        <p className="mt-3 text-3xs text-muted-foreground/80">
          Takes effect on the next chat; per-tool toggle coming soon.
        </p>
      </PopoverContent>
    </Popover>
  )
}

interface ServerRowProps {
  server: McpServerSummary
  onToggle?: (id: string, enabled: boolean) => void
  probeStatus?: ProbeStatus
  tools?: McpToolInfo[]
  onLoadTools?: (id: string) => void
}

function McpServerRow({
  server,
  onToggle,
  probeStatus,
  tools,
  onLoadTools
}: ServerRowProps): React.JSX.Element {
  const enabled = server.enabled !== false
  return (
    <li className="space-y-1.5 rounded-md border border-border/50 p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn('size-2 shrink-0 rounded-full', statusColor(probeStatus))}
          />
          <span className="min-w-0 truncate">
            <span className="block truncate text-sm font-medium">{server.name}</span>
            <span className="block text-3xs text-muted-foreground" title={statusLabel(probeStatus)}>
              {statusShortLabel(probeStatus)}
            </span>
          </span>
        </div>
        {onToggle && (
          <Switch
            checked={enabled}
            aria-label={`${enabled ? 'Disable' : 'Enable'} ${server.name}`}
            onCheckedChange={(checked) => {
              if (checked === enabled) return
              onToggle(server.id, checked)
            }}
          />
        )}
      </div>
      <Collapsible
        onOpenChange={(open) => {
          if (open && onLoadTools) onLoadTools(server.id)
        }}
      >
        <CollapsibleTrigger className="text-3xs text-muted-foreground underline-offset-2 hover:underline">
          {tools && tools.length > 0
            ? `${tools.length} tool${tools.length === 1 ? '' : 's'}`
            : 'Show tools'}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-1">
          {tools && tools.length > 0 ? (
            <ul className="space-y-0.5">
              {tools.map((tool) => (
                <li key={tool.name} className="flex min-w-0 items-baseline text-3xs">
                  <span className="font-mono font-medium text-foreground">{tool.name}</span>
                  {tool.description ? (
                    <span className="ml-1 min-w-0 flex-1 truncate text-muted-foreground/70">
                      — {tool.description}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : probeStatus === 'disconnected' ? (
            <p className="text-3xs text-destructive">Probe failed — check the server config.</p>
          ) : probeStatus === 'connected' ? (
            <p className="text-3xs text-muted-foreground">No tools available.</p>
          ) : (
            <p className="text-3xs text-muted-foreground">Probing…</p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
