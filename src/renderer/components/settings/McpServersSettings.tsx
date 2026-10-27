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
import { RowMenu } from '@/components/settings/RowMenu'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { type StatusTone, StatusWord } from '@/components/settings/StatusWord'
import { showUndoToast } from '@/components/settings/undo-toast'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { isMcpServerAutoProbed } from '@/hooks/use-acp-mcp'
import { MCP_UNSAFE_URL, McpOAuthError } from '@/lib/acp-api'
import { type StoredMcpServer, transportOf } from '@/lib/acp-mcp-persistence'
import { logFrontendError } from '@/lib/log-api'
import { parseMcpJsonImport } from '@/lib/mcp-json-import'
import { cn } from '@/lib/utils'
import { randomUUID } from '@/lib/uuid'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

type McpDialogState = { mode: 'add' } | { mode: 'edit'; server: StoredMcpServer }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oauthFailureMessage(error: unknown): string {
  if (error instanceof McpOAuthError && error.code === MCP_UNSAFE_URL) {
    return "This server's sign-in link isn't a secure https link, so Termul didn't open it."
  }
  return 'OAuth flow failed. Check your browser for the authorization page.'
}
/**
 * Durable failure log for a rejected MCP JSON import (AGENTS.md renderer
 * logging rule). The parser rejects BEFORE any persistence, so without this
 * the rejection is invisible outside the dialog. Parser error strings contain
 * server names + fixed texts only — never env/header values.
 */
function logMcpJsonRejection(errors: string[]): void {
  void logFrontendError({
    level: 'warn',
    source: 'settings.McpServersSettings',
    message: `MCP server JSON rejected: ${errors.join(' | ')}`
  })
}

/**
 * Serialize a stored server to the single-object JSON the edit dialog accepts:
 * `{type, name, command, args, env, enabled}` (stdio) or
 * `{type, name, url, headers, enabled}` (http/sse). `env` is shown as a
 * Claude-Desktop-style map and `headers` as `[{name, value}]` pairs — the
 * parser accepts and normalizes both shapes for either field. Empty
 * `args`/`env`/`headers` are omitted.
 */
function serverToJson(server: StoredMcpServer): string {
  const enabled = server.enabled !== false
  if (transportOf(server) === 'stdio') {
    const stdio = server as Extract<StoredMcpServer, { type?: 'stdio' }>
    const env: Record<string, string> = {}
    for (const pair of stdio.env ?? []) env[pair.name] = pair.value
    return JSON.stringify(
      {
        type: 'stdio',
        name: server.name,
        command: stdio.command,
        ...(stdio.args && stdio.args.length > 0 ? { args: stdio.args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        enabled
      },
      null,
      2
    )
  }
  const remote = server as Extract<StoredMcpServer, { type: 'http' | 'sse' }>
  return JSON.stringify(
    {
      type: transportOf(server),
      name: server.name,
      url: remote.url,
      ...(remote.headers && remote.headers.length > 0 ? { headers: remote.headers } : {}),
      enabled
    },
    null,
    2
  )
}

export function McpServersSettings(): React.JSX.Element {
  const servers = useAcpStore((state) => state.mcpServers)
  const saveMcpServer = useAcpStore((state) => state.saveMcpServer)
  const importMcpServers = useAcpStore((state) => state.importMcpServers)
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
  const [dialog, setDialog] = useState<McpDialogState | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [jsonErrors, setJsonErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
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

  const closeDialog = (): void => {
    setDialog(null)
    setJsonText('')
    setJsonErrors([])
  }

  const openAdd = (): void => {
    setDialog({ mode: 'add' })
    setJsonText('')
    setJsonErrors([])
  }

  const openEdit = (server: StoredMcpServer): void => {
    setDialog({ mode: 'edit', server })
    setJsonText(serverToJson(server))
    setJsonErrors([])
  }

  // Add mode: accepts a Claude Desktop `{"mcpServers": {...}}` wrapper or a
  // bare single-server object. The input is validated as a whole BEFORE any
  // persistence, and the accepted batch is committed through a single atomic
  // store write — so fixing a rejected entry and re-saving can never duplicate
  // previously saved entries, and a multi-server import triggers one registry
  // update (one on-mount probe pass) instead of one per server.
  const saveAdd = async (): Promise<void> => {
    const { servers: parsedServers, errors } = parseMcpJsonImport(jsonText)
    if (errors.length > 0) {
      // All-or-nothing: nothing is persisted until every entry parses, so a
      // corrected re-save starts from the same registry state.
      logMcpJsonRejection(errors)
      setJsonErrors(errors)
      return
    }
    if (parsedServers.length === 0) {
      const message = 'No MCP servers found in the JSON.'
      logMcpJsonRejection([message])
      setJsonErrors([message])
      return
    }
    const batch = parsedServers.map((parsed) => ({
      ...parsed,
      id: randomUUID(),
      enabled: true
    }))
    try {
      await importMcpServers(batch)
      toast.success(`Added ${batch.length} MCP server${batch.length === 1 ? '' : 's'}`)
      closeDialog()
    } catch {
      // importMcpServers rolls back the whole batch on failure — nothing was
      // persisted, so the dialog stays open for a safe retry.
      toast.error('Could not save the MCP servers. Your previous settings were restored.')
    }
  }

  // Edit mode: updates the same registry entry (same id). The wrapper is
  // rejected — it would parse to N servers with fresh-name semantics, which
  // is ambiguous for a single-entry update.
  const saveEdit = async (target: StoredMcpServer): Promise<void> => {
    // `enabled` is not part of `McpServerConfig`, so `parseMcpJsonImport`
    // drops it like any unknown field — read an explicit boolean here first.
    let explicitEnabled: boolean | undefined
    try {
      const raw: unknown = JSON.parse(jsonText)
      if (isRecord(raw)) {
        if (raw.mcpServers !== undefined) {
          const message = 'Edit expects a single server object — remove the "mcpServers" wrapper.'
          logMcpJsonRejection([message])
          setJsonErrors([message])
          return
        }
        if (typeof raw.enabled === 'boolean') explicitEnabled = raw.enabled
      }
    } catch {
      // Invalid JSON — parseMcpJsonImport below reports the exact syntax error.
    }
    const { servers: parsedServers, errors } = parseMcpJsonImport(jsonText)
    if (errors.length > 0) {
      logMcpJsonRejection(errors)
      setJsonErrors(errors)
      return
    }
    const parsed = parsedServers[0]
    if (!parsed || parsedServers.length !== 1) {
      setJsonErrors(['Edit expects exactly one server object.'])
      return
    }
    try {
      await saveMcpServer({
        ...parsed,
        id: target.id,
        enabled: explicitEnabled ?? target.enabled ?? true
      })
      toast.success('MCP server updated')
      closeDialog()
    } catch {
      // The store already rolled back the in-memory list; keep the dialog
      // open so the edit is not lost.
      toast.error('Could not save the MCP server. Your previous settings were restored.')
    }
  }

  const saveJson = async (): Promise<void> => {
    if (!dialog || jsonText.trim().length === 0) return
    setSaving(true)
    setJsonErrors([])
    try {
      if (dialog.mode === 'add') await saveAdd()
      else await saveEdit(dialog.server)
    } finally {
      setSaving(false)
    }
  }

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
            <Button type="button" size="sm" onClick={openAdd}>
              <Plus size={14} /> Add server
            </Button>
          ) : null
        }
        footnote={
          <>
            Agents can also advertise experimental MCP-over-ACP (<code>mcpCapabilities.acp</code>).
            Termul does not read it yet.
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
              <Button type="button" size="sm" onClick={openAdd}>
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
                        <CollapsibleTrigger className="inline-flex shrink-0 items-center gap-1 rounded text-xs text-secondary-foreground underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring">
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
                                .then(() => toast.success(`Connected to ${server.name}`))
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
                        <DropdownMenuItem onSelect={() => openEdit(server)}>
                          <Pencil size={14} />
                          Edit as JSON
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
                        Termul could not reach this server. Check the command, URL and environment
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

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          // Block dismissal while a save is in flight — otherwise the in-flight
          // completion handler would close a newly opened editor, and a failed
          // save's JSON would be lost.
          if (!open && !saving) closeDialog()
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === 'edit' ? 'Edit MCP server' : 'Add MCP servers'}
            </DialogTitle>
            <DialogDescription>
              {dialog?.mode === 'edit'
                ? 'Edit this server as JSON. Unknown fields are dropped on save.'
                : 'Paste a Claude Desktop "mcpServers" config or a single server object.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label htmlFor="mcp-json" className="block space-y-1 text-sm">
              <span>MCP JSON</span>
              <Textarea
                id="mcp-json"
                rows={12}
                value={jsonText}
                onChange={(event) => setJsonText(event.target.value)}
                placeholder='{"mcpServers": {"dokploy": {"command": "npx", "args": ["-y", "@dokploy/mcp"], "env": {"DOKPLOY_URL": "..."}}}}'
                className="font-mono"
              />
            </label>
            {jsonErrors.length > 0 && (
              <ul role="alert" className="space-y-1 text-xs text-destructive">
                {jsonErrors.map((error) => (
                  <li key={error} className="break-words font-mono">
                    {error}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={jsonText.trim().length === 0 || saving}
              onClick={() => void saveJson()}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
