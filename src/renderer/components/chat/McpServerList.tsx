import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Switch } from '@/components/ui/switch'
import type { McpToolInfo, ProbeStatus } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import type { ConnectorsFootnote } from './composer/connectors-menu-model'

export interface McpServerSummary {
  id: string
  name: string
  enabled?: boolean
}

function statusColor(status: ProbeStatus | undefined): string {
  if (status === 'connected') return 'bg-connection'
  if (status === 'disconnected') return 'bg-destructive'
  if (status === 'authRequired') return 'bg-warning'
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

export interface McpServerListProps {
  count: number
  servers: McpServerSummary[]
  onToggle?: (id: string, enabled: boolean) => void
  probeStatus?: Record<string, ProbeStatus>
  probeError?: Record<string, string | undefined>
  tools?: Record<string, McpToolInfo[]>
  onLoadTools?: (id: string) => void
  /**
   * Reload this chat so the current MCP list and a new agent process apply.
   * Absent in surfaces that only display the list.
   */
  onReloadChat?: () => void
  reloadDisabled?: boolean
  /** Title while `reloadDisabled` is set. */
  reloadDisabledReason?: string | null
  reloading?: boolean
  /**
   * Merged onto the rows `<ul>` after its default `max-h-[300px] overflow-y-auto pr-2`
   * scroller classes, so a host that scrolls itself (the + sheet) can lift the cap.
   */
  listClassName?: string
  /** What shows under the rows; from `connectorsMenuModel`. Defaults to none. */
  footnote?: ConnectorsFootnote
}

/**
 * Summary line, per-server rows and the next-chat footnote of the phone
 * + sheet's Connectors view. Rows and the next-chat footnote render only
 * when there is at least one server; a stale chat's reload footnote also
 * renders with none. The host owns its own heading.
 */
export function McpServerList({
  count,
  servers,
  onToggle,
  probeStatus,
  probeError,
  tools,
  onLoadTools,
  onReloadChat,
  reloadDisabled = false,
  reloadDisabledReason,
  reloading = false,
  listClassName,
  footnote = 'none'
}: McpServerListProps): React.JSX.Element {
  return (
    <>
      <p className="mt-0.5 text-muted-foreground">
        {count > 0 ? `${count} attached to this session.` : 'No servers attached yet.'}
      </p>
      {servers.length > 0 && (
        <>
          <ul className={cn('mt-2 max-h-[300px] space-y-1.5 overflow-y-auto pr-2', listClassName)}>
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
          {footnote === 'next-chat' ? (
            <p className="mt-3 text-2xs text-muted-foreground">Takes effect on the next chat.</p>
          ) : null}
        </>
      )}
      {footnote === 'reload-chat' && onReloadChat ? (
        <div className="mt-3 flex items-center gap-2">
          <p className="min-w-0 flex-1 text-2xs text-muted-foreground">
            {servers.length > 0
              ? 'This chat still uses the previous servers.'
              : 'Reload this chat to use new agent settings.'}
          </p>
          <button
            type="button"
            onClick={onReloadChat}
            disabled={reloadDisabled || reloading}
            title={reloadDisabled ? (reloadDisabledReason ?? undefined) : undefined}
            className="inline-flex shrink-0 items-center rounded-md border border-connection/40 px-2 py-0.5 text-2xs font-medium transition-colors hover:bg-connection/15 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {reloading ? 'Reloading…' : 'Reload this chat'}
          </button>
        </div>
      ) : null}
    </>
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

export function McpServerRow({
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
            <span className="block text-2xs text-muted-foreground" title={statusLabel(probeStatus)}>
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
        <CollapsibleTrigger className="text-xs tabular-nums text-muted-foreground underline-offset-2 hover:underline">
          {tools && tools.length > 0
            ? `${tools.length} tool${tools.length === 1 ? '' : 's'}`
            : 'Show tools'}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-1">
          {tools && tools.length > 0 ? (
            <ul className="space-y-0.5">
              {tools.map((tool) => (
                <li key={tool.name} className="flex min-w-0 items-baseline text-2xs">
                  <span className="font-mono font-medium text-foreground">{tool.name}</span>
                  {tool.description ? (
                    <span
                      className="ml-1 min-w-0 flex-1 truncate text-muted-foreground"
                      title={tool.description}
                    >
                      — {tool.description}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : probeStatus === 'disconnected' ? (
            <p
              className="text-xs text-destructive"
              title={probeError ?? 'Termul could not reach this server.'}
            >
              Termul could not reach this server.
            </p>
          ) : probeStatus === 'connected' ? (
            <p className="text-2xs text-muted-foreground">No tools available.</p>
          ) : (
            <p className="text-2xs text-muted-foreground">Probing…</p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
