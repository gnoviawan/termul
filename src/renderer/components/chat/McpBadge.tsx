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
  /**
   * Per-server probe error (the backend's redacted `ProbeResult.error`). Shown
   * as the tooltip on the "Probe failed" line so the reason is diagnosable.
   */
  probeError?: Record<string, string | undefined>
  /** Per-server cached `tools/list` output (for the collapsible tool list). */
  tools?: Record<string, McpToolInfo[]>
  /** Auto-probe on first expand of a server's tool list. */
  onLoadTools?: (id: string) => void
}

function McpIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
    >
      <title>MCP</title>
      <path
        fill="currentColor"
        d="M9.795 1.694a4.287 4.287 0 0 1 6.061 0a4.28 4.28 0 0 1 1.181 3.819a4.28 4.28 0 0 1 3.819 1.181a4.287 4.287 0 0 1 0 6.061l-6.793 6.793a.25.25 0 0 0 0 .353l2.617 2.618a.75.75 0 1 1-1.061 1.061l-2.617-2.618a1.75 1.75 0 0 1 0-2.475l6.793-6.793a2.785 2.785 0 1 0-3.939-3.939l-5.9 5.9a.7.7 0 0 1-.249.165a.749.749 0 0 1-.812-1.225l5.9-5.901a2.785 2.785 0 1 0-3.939-3.939L2.931 10.68A.75.75 0 1 1 1.87 9.619z"
      />
      <path
        fill="currentColor"
        d="M12.42 4.069a.75.75 0 0 1 1.061 0a.75.75 0 0 1 0 1.061L7.33 11.28a2.79 2.79 0 0 0 0 3.94a2.79 2.79 0 0 0 3.94 0l6.15-6.151a.75.75 0 0 1 1.061 0a.75.75 0 0 1 0 1.061l-6.151 6.15a4.285 4.285 0 1 1-6.06-6.06z"
      />
    </svg>
  )
}

function statusColor(status: ProbeStatus | undefined): string {
  if (status === 'connected') return 'bg-connection'
  if (status === 'disconnected') return 'bg-destructive'
  if (status === 'authRequired') return 'bg-amber-500'
  return 'bg-muted-foreground/40'
}

/** Short visible status for the server row (pairs with the color dot). */
function statusShortLabel(status: ProbeStatus | undefined): string {
  if (status === 'connected') return 'Connected'
  if (status === 'disconnected') return 'Disconnected'
  if (status === 'authRequired') return 'Needs auth'
  return 'Not probed'
}

function statusLabel(status: ProbeStatus | undefined): string {
  if (status === 'connected') return 'Connected (Termul can reach this server)'
  if (status === 'disconnected') return 'Disconnected (Termul could not reach this server)'
  if (status === 'authRequired') return 'Authentication required — connect in MCP Server settings'
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
  probeError,
  tools,
  onLoadTools
}: McpBadgeProps): React.JSX.Element | null {
  const hasServerList = servers != null && servers.length > 0
  if (count <= 0 && !hasServerList) return null

  // Count-only pill (backward-compat — no server list passed).
  if (!hasServerList) {
    return (
      <button
        type="button"
        className={cn(
          'relative flex size-8 items-center justify-center text-muted-foreground transition-colors',
          "after:absolute after:-inset-1.5 after:content-['']",
          'hover:text-foreground',
          className
        )}
        aria-label={`MCP servers — ${count} attached`}
      >
        <McpIcon className="size-4" />
      </button>
    )
  }

  return (
    <McpPopover
      count={count}
      servers={servers!}
      onToggle={onToggle}
      probeStatus={probeStatus}
      probeError={probeError}
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
  probeError?: Record<string, string | undefined>
  tools?: Record<string, McpToolInfo[]>
  onLoadTools?: (id: string) => void
  className?: string
}

function McpPopover({
  count,
  servers,
  onToggle,
  probeStatus,
  probeError,
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
            'relative flex size-8 items-center justify-center text-muted-foreground transition-colors',
            "after:absolute after:-inset-1.5 after:content-['']",
            'hover:text-foreground',
            className
          )}
          aria-label={`MCP servers — ${count} attached. Click to manage per-server enable/disable.`}
        >
          <McpIcon className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3 text-xs">
        <p className="font-medium text-foreground">MCP servers</p>
        <p className="mt-0.5 text-muted-foreground">
          {count > 0 ? `${count} attached to this session.` : 'No servers attached yet.'}
        </p>
        <ul className="mt-2 max-h-[300px] space-y-1.5 overflow-y-auto pr-2">
          {servers.map((server) => (
            <McpServerRow
              key={server.id}
              server={server}
              onToggle={onToggle}
              probeStatus={probeStatus?.[server.id]}
              probeError={probeError?.[server.id]}
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
  probeError?: string
  tools?: McpToolInfo[]
  onLoadTools?: (id: string) => void
}

function McpServerRow({
  server,
  onToggle,
  probeStatus,
  probeError,
  tools,
  onLoadTools
}: ServerRowProps): React.JSX.Element {
  const enabled = server.enabled !== false
  return (
    <li className="space-y-1 rounded-md border border-border/50 p-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn('size-1.5 shrink-0 rounded-full', statusColor(probeStatus))}
          />
          <span className="min-w-0 truncate">
            <span className="block truncate text-xs font-medium">{server.name}</span>
            <span className="block text-3xs text-muted-foreground" title={statusLabel(probeStatus)}>
              {statusShortLabel(probeStatus)}
            </span>
          </span>
        </div>
        {onToggle && (
          <Switch
            checked={enabled}
            className="h-3.5 w-6 border [&>span]:h-2.5 [&>span]:w-2.5 [&>span[data-state=checked]]:translate-x-2.5"
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
            <p className="text-3xs text-destructive" title={probeError ?? 'Probe failed.'}>
              Probe failed — check the server config.
            </p>
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
