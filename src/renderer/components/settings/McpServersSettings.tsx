import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronDown,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Unlink
} from '@/components/icons'
import { useMcpServerDialog } from '@/components/settings/McpServerDialog'
import { RowMenu } from '@/components/settings/RowMenu'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { type StatusTone, StatusWord } from '@/components/settings/StatusWord'
import { showUndoToast } from '@/components/settings/undo-toast'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { isMcpServerAutoProbed } from '@/hooks/use-acp-mcp'
import { MCP_UNSAFE_URL, McpOAuthError } from '@/lib/acp-api'
import { type StoredMcpServer, transportOf } from '@/lib/acp-mcp-persistence'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

export function oauthFailureMessage(error: unknown): string {
  if (error instanceof McpOAuthError && error.code === MCP_UNSAFE_URL) {
    return "This server's sign-in link isn't a secure https link, so Troupe didn't open it."
  }
  return 'OAuth flow failed. Check your browser for the authorization page.'
}

export function McpServersSettings(): React.JSX.Element {
  const mcpDialog = useMcpServerDialog()
  const servers = useAcpStore((state) => state.mcpServers)
  const saveMcpServer = useAcpStore((state) => state.saveMcpServer)
  const setMcpServerEnabled = useAcpStore((state) => state.setMcpServerEnabled)
  const deleteMcpServer = useAcpStore((state) => state.deleteMcpServer)
  const probeMcpServer = useAcpStore((state) => state.probeMcpServer)
  const loadMcpTools = useAcpStore((state) => state.loadMcpTools)
  const mcpProbeStatus = useAcpStore((state) => state.mcpProbeStatus)
  const mcpProbeError = useAcpStore((state) => state.mcpProbeError)
  const mcpTools = useAcpStore((state) => state.mcpTools)
  const mcpProbing = useAcpStore((state) => state.mcpProbing)
  const mcpOAuthConnecting = useAcpStore((state) => state.mcpOAuthConnecting)
  const mcpOAuthConnected = useAcpStore((state) => state.mcpOAuthConnected)
  const connectMcpOAuth = useAcpStore((state) => state.connectMcpOAuth)
  const disconnectMcpOAuth = useAcpStore((state) => state.disconnectMcpOAuth)
  const checkMcpOAuthStatus = useAcpStore((state) => state.checkMcpOAuthStatus)
  // OAuth host calls name the active project (the web host authorizes the URL
  // against that project's MCP list).
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  // Tracks which server rows have their tool list expanded (Settings surface).
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({})

  // On Settings mount, probe each configured server once (on-demand) — but
  // skip ids the boot auto-probe pass (`useAcpMcp`) already covered this app
  // run, so opening Settings right after launch does not re-spawn every
  // stdio server. Errors are surfaced in the dot — never crashed. Re-runs
  // when the registry list changes shape (add/delete) but not on every
  // toggle (toggle doesn't change reachability); the manual per-row Test
  // button remains the explicit refresh affordance.
  // biome-ignore lint/correctness/useExhaustiveDependencies: shape-only dep — re-probe only when the id set changes shape, not on every toggle; `probeMcpServer` is a stable store action reference.
  useEffect(() => {
    for (const server of servers) {
      if (server.enabled === false) continue
      if (isMcpServerAutoProbed(server.id)) continue
      void probeMcpServer(server.id)
    }
  }, [servers.map((s) => s.id).join('|')])

  // Check OAuth token status for HTTP/SSE servers on mount. If a token
  // exists, the probe will use it automatically and show "connected".
  // biome-ignore lint/correctness/useExhaustiveDependencies: shape-only dep
  useEffect(() => {
    for (const server of servers) {
      if (transportOf(server) === 'http' || transportOf(server) === 'sse') {
        void checkMcpOAuthStatus(activeProjectId, server.id)
      }
    }
  }, [servers.map((s) => s.id).join('|'), activeProjectId])

  const deleteServer = (server: StoredMcpServer): void => {
    void deleteMcpServer(server.id)
      .then(() => {
        void logFrontendError({
          level: 'info',
          source: 'settings.McpServersSettings',
          message: 'MCP server deleted; undo offered'
        })
        showUndoToast(`Deleted ${server.name}`, () => {
          void saveMcpServer(server)
            .then(() =>
              logFrontendError({
                level: 'info',
                source: 'settings.McpServersSettings',
                message: 'MCP server restored by undo'
              })
            )
            .catch(() => toast.error('Could not restore the MCP server. Add it again from JSON.'))
        })
      })
      .catch(() => {
        toast.error('Could not delete the MCP server. Your previous settings were restored.')
      })
  }

  const enabledCount = servers.filter((server) => server.enabled !== false).length
  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup
        title={
          servers.length === 0
            ? 'Global MCP registry'
            : `${servers.length} server${servers.length === 1 ? '' : 's'} · ${enabledCount} enabled`
        }
        actions={
          servers.length > 0 ? (
            <Button type="button" size="sm" onClick={mcpDialog.openAdd}>
              <Plus size={14} /> Add server
            </Button>
          ) : null
        }
        footnote={
          <>
            Agents can also advertise experimental MCP-over-ACP (<code>mcpCapabilities.acp</code>).
            Troupe does not read it yet.
          </>
        }
      >
        <SettingsNotice tone="warning">
          Environment values and headers are saved in app data. Use <code>$VARIABLE</code>{' '}
          references instead of real secrets.
        </SettingsNotice>

        {servers.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-card px-6 py-8 text-center">
            <Server size={20} className="mb-1 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No MCP servers configured</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Add a stdio, HTTP, or SSE server. New agent chats can then use its tools.
            </p>
            <div className="pt-2">
              <Button type="button" size="sm" onClick={mcpDialog.openAdd}>
                <Plus size={14} /> Add server
              </Button>
            </div>
          </div>
        ) : (
          <SettingsCard>
            {servers.map((server) => {
              const probeStatus = mcpProbeStatus[server.id]
              const probing = Boolean(mcpProbing[server.id])
              const tools = mcpTools[server.id]
              const isOpen = Boolean(expandedTools[server.id])
              const enabled = server.enabled !== false
              const oauthConnected = Boolean(mcpOAuthConnected[server.id])
              const oauthConnecting = Boolean(mcpOAuthConnecting[server.id])
              const detail =
                transportOf(server) === 'stdio'
                  ? (server as Extract<StoredMcpServer, { type?: 'stdio' }>).command
                  : (server as Extract<StoredMcpServer, { type: 'http' | 'sse' }>).url
              const status: { tone: StatusTone; label: string } = !enabled
                ? { tone: 'muted', label: 'Off' }
                : probing
                  ? { tone: 'muted', label: 'Checking…' }
                  : probeStatus === 'connected'
                    ? { tone: 'success', label: 'Connected' }
                    : probeStatus === 'disconnected'
                      ? { tone: 'danger', label: 'Unreachable' }
                      : probeStatus === 'authRequired'
                        ? { tone: 'warning', label: 'Needs sign-in' }
                        : { tone: 'muted', label: 'Not checked' }
              return (
                <Collapsible
                  key={server.id}
                  open={isOpen}
                  onOpenChange={(next) => {
                    setExpandedTools((prev) => ({ ...prev, [server.id]: next }))
                    if (next) void loadMcpTools(server.id)
                  }}
                >
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-56">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            'min-w-0 truncate text-sm font-medium',
                            enabled ? 'text-foreground' : 'text-muted-foreground'
                          )}
                        >
                          {server.name}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1.5 py-px text-3xs font-medium uppercase text-muted-foreground">
                          {transportOf(server)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-3">
                        <span
                          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
                          title={detail}
                        >
                          {detail}
                        </span>
                        <CollapsibleTrigger className="inline-flex shrink-0 items-center gap-1 rounded text-xs text-secondary-foreground underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-focus-ring">
                          {tools && tools.length > 0
                            ? `${tools.length} tool${tools.length === 1 ? '' : 's'}`
                            : probeStatus === 'disconnected'
                              ? isOpen
                                ? 'Hide error'
                                : 'Show error'
                              : 'Show tools'}
                          <ChevronDown
                            size={12}
                            className={cn(
                              'transition-transform duration-150',
                              isOpen && 'rotate-180'
                            )}
                          />
                        </CollapsibleTrigger>
                      </div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-3">
                      <StatusWord tone={status.tone} pending={probing}>
                        {status.label}
                      </StatusWord>
                      {(probeStatus === 'authRequired' || oauthConnected) && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={oauthConnecting}
                          onClick={() => {
                            if (oauthConnected) {
                              void disconnectMcpOAuth(activeProjectId, server.id).catch(() =>
                                toast.error('Could not disconnect OAuth. Try again.')
                              )
                            } else {
                              void connectMcpOAuth(activeProjectId, server.id)
                                .then((connected) => {
                                  if (connected) toast.success(`Connected to ${server.name}`)
                                })
                                .catch((error: unknown) => toast.error(oauthFailureMessage(error)))
                            }
                          }}
                        >
                          {oauthConnecting ? (
                            <Spinner size={13} decorative />
                          ) : oauthConnected ? (
                            <Unlink size={13} />
                          ) : (
                            <ExternalLink size={13} />
                          )}
                          {oauthConnecting
                            ? 'Connecting…'
                            : oauthConnected
                              ? 'Disconnect'
                              : 'Connect'}
                        </Button>
                      )}
                      <Switch
                        checked={enabled}
                        aria-label={`${enabled ? 'Disable' : 'Enable'} ${server.name}`}
                        onCheckedChange={(next) => {
                          void setMcpServerEnabled(server.id, next).catch(() => {
                            toast.error(
                              'Could not update the MCP server. Your previous setting was restored.'
                            )
                          })
                        }}
                      />
                      <RowMenu label={`Actions for ${server.name}`}>
                        <DropdownMenuItem
                          disabled={probing}
                          onSelect={() => void probeMcpServer(server.id)}
                        >
                          <RefreshCw size={14} />
                          Test connection
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => mcpDialog.openEdit(server)}>
                          <Pencil size={14} />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() => deleteServer(server)}
                          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                        >
                          <Trash2 size={14} />
                          Delete
                        </DropdownMenuItem>
                      </RowMenu>
                    </div>
                  </div>
                  <CollapsibleContent className="px-4 pb-3">
                    {tools && tools.length > 0 ? (
                      <ul className="flex flex-col gap-1 rounded-md border border-border bg-background px-3 py-2.5">
                        {tools.map((tool) => (
                          <li key={tool.name} className="flex min-w-0 items-baseline gap-2 text-xs">
                            <span className="shrink-0 font-mono text-foreground">{tool.name}</span>
                            {tool.description ? (
                              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                {tool.description}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : probeStatus === 'disconnected' ? (
                      <SettingsNotice
                        tone="danger"
                        action={
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={probing}
                            onClick={() => void probeMcpServer(server.id)}
                          >
                            <RefreshCw size={13} />
                            Try again
                          </Button>
                        }
                      >
                        Troupe could not reach this server. Check the command, URL and environment
                        values, then try again.
                        {mcpProbeError[server.id] ? (
                          <span className="mt-1 block break-words font-mono text-muted-foreground">
                            {mcpProbeError[server.id]}
                          </span>
                        ) : null}
                      </SettingsNotice>
                    ) : probeStatus === 'authRequired' ? (
                      <SettingsNotice tone="warning">
                        This server uses OAuth. Select Connect to sign in in your browser.
                      </SettingsNotice>
                    ) : probeStatus === 'connected' ? (
                      <SettingsNotice>The server answered but offers no tools.</SettingsNotice>
                    ) : probing ? (
                      <p className="text-xs text-muted-foreground">Checking…</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Opening the tool list runs the first check (read-only).
                      </p>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              )
            })}
          </SettingsCard>
        )}
      </SettingsGroup>
      {mcpDialog.element}
    </div>
  )
}
