import { AlertTriangle, ChevronDown, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { type StoredMcpServer, transportOf } from '@/lib/acp-mcp-persistence'
import { parseMcpJsonImport } from '@/lib/mcp-json-import'
import { useAcpStore } from '@/stores/acp-store'

type McpDialogState = { mode: 'add' } | { mode: 'edit'; server: StoredMcpServer }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Serialize a stored server to the single-object JSON the edit dialog accepts:
 * `{type, name, command, args, env, enabled}` (stdio) or
 * `{type, name, url, headers, enabled}` (http/sse). `env` is shown as a
 * Claude-Desktop-style map (the parser normalizes map -> pairs); `headers`
 * stays `[{name, value}]` pairs — the only shape the parser accepts. Empty
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
  const setMcpServerEnabled = useAcpStore((state) => state.setMcpServerEnabled)
  const deleteMcpServer = useAcpStore((state) => state.deleteMcpServer)
  const probeMcpServer = useAcpStore((state) => state.probeMcpServer)
  const loadMcpTools = useAcpStore((state) => state.loadMcpTools)
  const mcpProbeStatus = useAcpStore((state) => state.mcpProbeStatus)
  const mcpProbeError = useAcpStore((state) => state.mcpProbeError)
  const mcpTools = useAcpStore((state) => state.mcpTools)
  const mcpProbing = useAcpStore((state) => state.mcpProbing)
  const [dialog, setDialog] = useState<McpDialogState | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [jsonErrors, setJsonErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  // Tracks which server rows have their tool list expanded (Settings surface).
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({})

  // On Settings mount, probe each configured server once (on-demand). Errors
  // are surfaced in the dot — never crashed. Re-runs when the registry list
  // changes shape (add/delete) but not on every toggle (toggle doesn't change
  // reachability).
  // biome-ignore lint/correctness/useExhaustiveDependencies: shape-only dep — re-probe only when the id set changes shape, not on every toggle; `probeMcpServer` is a stable store action reference.
  useEffect(() => {
    for (const server of servers) {
      // Skip disabled servers on mount — they are not injected into sessions, so
      // their reachability status is not actionable at idle. The manual "Test"
      // button below still probes a disabled server on explicit request.
      if (server.enabled === false) continue
      // Fire-and-forget; the store dedupes concurrent probes per id.
      void probeMcpServer(server.id)
    }
  }, [servers.map((s) => s.id).join('|')])

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
  // bare single-server object; every parsed entry saves with a fresh id (no
  // overwrite-by-name).
  const saveAdd = async (): Promise<void> => {
    let savedCount = 0
    try {
      const { servers: parsedServers, errors } = parseMcpJsonImport(jsonText)
      // Valid servers still save when some entries are rejected (per-server
      // errors stay visible inline so the user can fix and re-save).
      for (const parsed of parsedServers) {
        await saveMcpServer({ ...parsed, id: crypto.randomUUID(), enabled: true })
        savedCount += 1
      }
      if (errors.length > 0) {
        setJsonErrors(errors)
        return
      }
      if (parsedServers.length === 0) {
        setJsonErrors(['No MCP servers found in the JSON.'])
        return
      }
      toast.success(
        `Imported ${parsedServers.length} MCP server${parsedServers.length === 1 ? '' : 's'}`
      )
      closeDialog()
    } catch {
      // A mid-loop throw leaves earlier saves persisted (fresh IDs each time).
      // Tell the user how many landed so they do not blindly re-save and
      // create duplicates.
      toast.error(
        savedCount > 0
          ? `Imported ${savedCount} server${savedCount === 1 ? '' : 's'} before a save failed. Review the remaining entries before re-saving.`
          : 'Could not save the MCP server. Your previous settings were restored.'
      )
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
          setJsonErrors(['Edit expects a single server object — remove the "mcpServers" wrapper.'])
          return
        }
        if (typeof raw.enabled === 'boolean') explicitEnabled = raw.enabled
      }
    } catch {
      // Invalid JSON — parseMcpJsonImport below reports the exact syntax error.
    }
    const { servers: parsedServers, errors } = parseMcpJsonImport(jsonText)
    if (errors.length > 0) {
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

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/20 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">Global MCP registry</p>
          <p className="text-xs text-muted-foreground">
            Enabled servers are offered automatically when a new agent session starts.
          </p>
        </div>
        <Button type="button" size="sm" onClick={openAdd}>
          <Plus size={14} className="mr-1.5" /> Add server
        </Button>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <p>
            Environment variables and headers are stored in the existing application data store.
            Prefer <code>$VARIABLE</code> references instead of literal credentials.
          </p>
        </div>
      </div>

      {servers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <Server size={24} className="mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm font-medium">No MCP servers configured</p>
          <p className="mt-1 text-xs text-muted-foreground">Add a stdio, HTTP, or SSE server.</p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {servers.map((server) => {
            const probeStatus = mcpProbeStatus[server.id]
            const probing = Boolean(mcpProbing[server.id])
            const tools = mcpTools[server.id]
            const isOpen = Boolean(expandedTools[server.id])
            const detail =
              transportOf(server) === 'stdio'
                ? (server as Extract<StoredMcpServer, { type?: 'stdio' }>).command
                : (server as Extract<StoredMcpServer, { type: 'http' | 'sse' }>).url
            return (
              <Collapsible
                key={server.id}
                open={isOpen}
                onOpenChange={(next) => {
                  setExpandedTools((prev) => ({ ...prev, [server.id]: next }))
                  if (next) void loadMcpTools(server.id)
                }}
              >
                {/* Compact one-line row: status dot, name, transport,
                    command/URL, tools trigger, and every row action. Tool
                    and probe details stay opt-in behind the disclosure. */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <span
                    role="img"
                    className={
                      probeStatus === 'connected'
                        ? 'size-2 shrink-0 rounded-full bg-emerald-500'
                        : probeStatus === 'disconnected'
                          ? 'size-2 shrink-0 rounded-full bg-red-500'
                          : 'size-2 shrink-0 rounded-full bg-muted-foreground/40'
                    }
                    aria-label={
                      probeStatus === 'connected'
                        ? `${server.name} reachable`
                        : probeStatus === 'disconnected'
                          ? `${server.name} unreachable`
                          : `${server.name} not probed yet`
                    }
                    title={
                      probeStatus === 'connected'
                        ? 'Connected (Termul can reach this server)'
                        : probeStatus === 'disconnected'
                          ? 'Disconnected (Termul could not reach this server)'
                          : 'Not probed yet — click "Test" to check'
                    }
                  />
                  <span className="min-w-0 shrink truncate text-sm font-medium">{server.name}</span>
                  <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-3xs font-medium uppercase text-muted-foreground">
                    {transportOf(server)}
                  </span>
                  <span className="hidden min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground sm:block">
                    {detail}
                  </span>
                  <CollapsibleTrigger className="inline-flex shrink-0 items-center gap-1 text-3xs text-muted-foreground underline-offset-2 hover:underline">
                    <ChevronDown size={12} className={isOpen ? 'rotate-180' : ''} />
                    {tools && tools.length > 0
                      ? `${tools.length} tool${tools.length === 1 ? '' : 's'}`
                      : probeStatus === 'disconnected'
                        ? 'Probe failed — retry'
                        : 'Show tools'}
                  </CollapsibleTrigger>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={probing}
                    onClick={() => void probeMcpServer(server.id)}
                    aria-label={`Test ${server.name} connection`}
                  >
                    <RefreshCw size={14} className={probing ? 'animate-spin' : ''} />
                  </Button>
                  <Switch
                    checked={server.enabled !== false}
                    aria-label={`${server.enabled !== false ? 'Disable' : 'Enable'} ${server.name}`}
                    onCheckedChange={(enabled) => {
                      void setMcpServerEnabled(server.id, enabled).catch(() => {
                        toast.error(
                          'Could not update the MCP server. Your previous setting was restored.'
                        )
                      })
                    }}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => openEdit(server)}
                  >
                    <Pencil size={15} />
                    <span className="sr-only">Edit {server.name}</span>
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      void deleteMcpServer(server.id).catch(() => {
                        toast.error(
                          'Could not delete the MCP server. Your previous settings were restored.'
                        )
                      })
                    }}
                  >
                    <Trash2 size={15} />
                    <span className="sr-only">Delete {server.name}</span>
                  </Button>
                </div>
                <CollapsibleContent className="px-3 pb-2">
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
                    <div className="space-y-1">
                      <p className="text-3xs text-destructive">
                        Probe failed — check the server config or network.
                      </p>
                      {mcpProbeError[server.id] ? (
                        <span className="block font-mono text-3xs text-destructive/80">
                          {mcpProbeError[server.id]}
                        </span>
                      ) : null}
                    </div>
                  ) : probeStatus === 'connected' ? (
                    <p className="text-3xs text-muted-foreground">
                      Probe completed — no tools found.
                    </p>
                  ) : probing ? (
                    <p className="text-3xs text-muted-foreground">Probing…</p>
                  ) : (
                    <p className="text-3xs text-muted-foreground">
                      Expand to probe (read-only — per-tool toggle coming soon).
                    </p>
                  )}
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </div>
      )}

      <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Experimental MCP-over-ACP</p>
        <p className="mt-1">
          Agents may advertise an experimental <code>mcpCapabilities.acp</code> capability. Termul
          retains that capability for diagnostics, but no native ACP transport can be configured
          until Termul has an in-process MCP server handler.
        </p>
      </div>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog()
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
            <Button type="button" variant="outline" onClick={closeDialog}>
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
