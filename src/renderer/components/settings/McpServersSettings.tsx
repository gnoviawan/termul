import { AlertTriangle, ChevronDown, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { McpServerConfig } from '@/lib/acp-api'
import {
  type McpTransport,
  type StoredMcpServer,
  transportOf,
  validateMcpServer
} from '@/lib/acp-mcp-persistence'
import { parseMcpJsonImport } from '@/lib/mcp-json-import'
import { useAcpStore } from '@/stores/acp-store'

interface ServerDraft {
  id?: string
  type: McpTransport
  name: string
  command: string
  args: string
  env: string
  url: string
  headers: string
  enabled: boolean
}

const EMPTY_DRAFT: ServerDraft = {
  type: 'stdio',
  name: '',
  command: '',
  args: '',
  env: '',
  url: '',
  headers: '',
  enabled: true
}

function pairsToText(pairs: Array<{ name: string; value: string }> | undefined): string {
  return pairs?.map((pair) => `${pair.name}=${pair.value}`).join('\n') ?? ''
}

function textToPairs(text: string): Array<{ name: string; value: string }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=')
      return separator === -1
        ? { name: line, value: '' }
        : { name: line.slice(0, separator).trim(), value: line.slice(separator + 1) }
    })
    .filter((pair) => pair.name.length > 0)
}

function draftFor(server: StoredMcpServer): ServerDraft {
  const type = transportOf(server)
  if (type === 'stdio') {
    const stdio = server as Extract<StoredMcpServer, { type?: 'stdio' }>
    return {
      id: server.id,
      type,
      name: server.name,
      command: stdio.command,
      args: stdio.args?.join('\n') ?? '',
      env: pairsToText(stdio.env),
      url: '',
      headers: '',
      enabled: server.enabled !== false
    }
  }
  const remote = server as Extract<StoredMcpServer, { type: 'http' | 'sse' }>
  return {
    id: server.id,
    type,
    name: server.name,
    command: '',
    args: '',
    env: '',
    url: remote.url,
    headers: pairsToText(remote.headers),
    enabled: server.enabled !== false
  }
}

function configFor(draft: ServerDraft): McpServerConfig {
  if (draft.type === 'stdio') {
    const args = draft.args
      .split('\n')
      .map((arg) => arg.trim())
      .filter(Boolean)
    return {
      type: 'stdio',
      name: draft.name.trim(),
      command: draft.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(draft.env.trim() ? { env: textToPairs(draft.env) } : {})
    }
  }
  return {
    type: draft.type,
    name: draft.name.trim(),
    url: draft.url.trim(),
    ...(draft.headers.trim() ? { headers: textToPairs(draft.headers) } : {})
  }
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
  const [draft, setDraft] = useState<ServerDraft | null>(null)
  const [saving, setSaving] = useState(false)
  // "Form | Import JSON" toggle inside the Add/Edit dialog. Import mode pastes
  // a Claude Desktop `{"mcpServers": {...}}` config (or a bare single server)
  // and saves each parsed entry with a fresh id.
  const [importMode, setImportMode] = useState(false)
  const [importText, setImportText] = useState('')
  const [importErrors, setImportErrors] = useState<string[]>([])
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

  const validation = useMemo(
    () => (draft ? validateMcpServer(configFor(draft)) : { valid: false, errors: [] }),
    [draft]
  )

  const persistDraft = async (): Promise<void> => {
    if (!draft || !validation.valid) return
    setSaving(true)
    try {
      await saveMcpServer({
        ...configFor(draft),
        id: draft.id ?? crypto.randomUUID(),
        enabled: draft.enabled
      })
      setDraft(null)
      toast.success(draft.id ? 'MCP server updated' : 'MCP server added')
    } catch {
      toast.error('Could not save the MCP server. Your previous settings were restored.')
    } finally {
      setSaving(false)
    }
  }

  const closeDialog = (): void => {
    setDraft(null)
    setImportMode(false)
    setImportErrors([])
  }

  const saveImport = async (): Promise<void> => {
    setSaving(true)
    setImportErrors([])
    let savedCount = 0
    try {
      const { servers: parsedServers, errors } = parseMcpJsonImport(importText)
      // Valid servers still import when some entries are rejected (per-server
      // errors stay visible inline so the user can fix and re-paste).
      for (const server of parsedServers) {
        await saveMcpServer({ ...server, id: crypto.randomUUID(), enabled: true })
        savedCount += 1
      }
      if (errors.length > 0) {
        setImportErrors(errors)
        return
      }
      if (parsedServers.length === 0) {
        setImportErrors(['No MCP servers found in the JSON.'])
        return
      }
      toast.success(
        `Imported ${parsedServers.length} MCP server${parsedServers.length === 1 ? '' : 's'}`
      )
      setImportText('')
      closeDialog()
    } catch {
      // A mid-loop throw leaves earlier saves persisted (fresh IDs each time).
      // Tell the user how many landed so they do not blindly re-paste and
      // create duplicates.
      toast.error(
        savedCount > 0
          ? `Imported ${savedCount} server${savedCount === 1 ? '' : 's'} before a save failed. Review the remaining entries before re-importing.`
          : 'Could not save the MCP server. Your previous settings were restored.'
      )
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
        <Button type="button" size="sm" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
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
        <div className="space-y-2">
          {servers.map((server) => {
            const probeStatus = mcpProbeStatus[server.id]
            const probing = Boolean(mcpProbing[server.id])
            const tools = mcpTools[server.id]
            const isOpen = Boolean(expandedTools[server.id])
            return (
              <div
                key={server.id}
                className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-start"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      role="img"
                      className={
                        probeStatus === 'connected'
                          ? 'size-2 rounded-full bg-emerald-500'
                          : probeStatus === 'disconnected'
                            ? 'size-2 rounded-full bg-red-500'
                            : 'size-2 rounded-full bg-muted-foreground/40'
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
                    <span className="truncate text-sm font-medium">{server.name}</span>
                    <span className="rounded bg-secondary px-1.5 py-0.5 text-3xs font-medium uppercase text-muted-foreground">
                      {transportOf(server)}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {transportOf(server) === 'stdio'
                      ? (server as Extract<StoredMcpServer, { type?: 'stdio' }>).command
                      : (server as Extract<StoredMcpServer, { type: 'http' | 'sse' }>).url}
                  </p>
                  <Collapsible
                    open={isOpen}
                    onOpenChange={(next) => {
                      setExpandedTools((prev) => ({ ...prev, [server.id]: next }))
                      if (next) void loadMcpTools(server.id)
                    }}
                  >
                    <CollapsibleTrigger className="mt-1 inline-flex items-center gap-1 text-3xs text-muted-foreground underline-offset-2 hover:underline">
                      <ChevronDown size={12} className={isOpen ? 'rotate-180' : ''} />
                      {tools && tools.length > 0
                        ? `${tools.length} tool${tools.length === 1 ? '' : 's'}`
                        : probeStatus === 'disconnected'
                          ? 'Probe failed — retry'
                          : 'Show tools'}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-1">
                      {tools && tools.length > 0 ? (
                        <ul className="space-y-0.5">
                          {tools.map((tool) => (
                            <li key={tool.name} className="flex min-w-0 items-baseline text-3xs">
                              <span className="font-mono font-medium text-foreground">
                                {tool.name}
                              </span>
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
                </div>
                <div className="flex items-center justify-between gap-2 sm:justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={probing}
                    onClick={() => void probeMcpServer(server.id)}
                    aria-label={`Test ${server.name} connection`}
                  >
                    <RefreshCw size={14} className={probing ? 'animate-spin' : ''} />
                    <span className="ml-1.5">Test</span>
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
                    onClick={() => {
                      // Ensure a lingering import session cannot resurface
                      // the (now-hidden) import view while editing.
                      setImportMode(false)
                      setDraft(draftFor(server))
                    }}
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
              </div>
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
        open={draft !== null || importMode}
        onOpenChange={(open) => {
          if (!open) closeDialog()
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {importMode ? 'Import MCP servers' : draft?.id ? 'Edit MCP server' : 'Add MCP server'}
            </DialogTitle>
            <DialogDescription>
              {importMode
                ? 'Paste a Claude Desktop config or a single server object, then parse and save.'
                : 'Configure one server transport. Each argument or key/value pair uses its own line.'}
            </DialogDescription>
          </DialogHeader>
          <div
            role="tablist"
            aria-label="MCP server entry mode"
            className="flex w-fit gap-1 rounded-lg border border-border bg-secondary/20 p-1"
            // The Import tab is an Add-only flow — importing while editing an
            // existing server would persist fresh IDs instead of updating the
            // draft, so the tab bar is hidden whenever a server is being edited.
            hidden={Boolean(draft?.id)}
          >
            <button
              type="button"
              role="tab"
              aria-selected={!importMode}
              onClick={() => {
                setImportMode(false)
                setImportErrors([])
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                !importMode
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Form
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={importMode}
              onClick={() => {
                setImportMode(true)
                setImportErrors([])
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                importMode
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Import JSON
            </button>
          </div>
          {importMode ? (
            <div className="space-y-4">
              <label htmlFor="mcp-import-json" className="block space-y-1 text-sm">
                <span>MCP JSON</span>
                <Textarea
                  id="mcp-import-json"
                  rows={10}
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  placeholder='{"mcpServers": {"dokploy": {"command": "npx", "args": ["-y", "@dokploy/mcp"], "env": {"DOKPLOY_URL": "..."}}}}'
                  className="font-mono"
                />
              </label>
              {importErrors.length > 0 && (
                <ul role="alert" className="space-y-1 text-xs text-destructive">
                  {importErrors.map((error) => (
                    <li key={error} className="break-words font-mono">
                      {error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            draft && (
              <div className="space-y-4">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label htmlFor="mcp-server-name" className="space-y-1 text-sm">
                    <span>Name</span>
                    <Input
                      id="mcp-server-name"
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                  </label>
                  <label htmlFor="mcp-server-transport" className="space-y-1 text-sm">
                    <span>Transport</span>
                    <select
                      id="mcp-server-transport"
                      value={draft.type}
                      onChange={(event) =>
                        setDraft({ ...draft, type: event.target.value as McpTransport })
                      }
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="stdio">stdio</option>
                      <option value="http">HTTP</option>
                      <option value="sse">SSE</option>
                    </select>
                  </label>
                </div>
                {draft.type === 'stdio' ? (
                  <>
                    <label htmlFor="mcp-command" className="block space-y-1 text-sm">
                      <span>Command</span>
                      <Input
                        id="mcp-command"
                        value={draft.command}
                        onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                      />
                    </label>
                    <label htmlFor="mcp-arguments" className="block space-y-1 text-sm">
                      <span>Arguments (one per line)</span>
                      <Textarea
                        id="mcp-arguments"
                        value={draft.args}
                        onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                      />
                    </label>
                    <label htmlFor="mcp-environment" className="block space-y-1 text-sm">
                      <span>Environment (NAME=value, one per line)</span>
                      <Textarea
                        id="mcp-environment"
                        value={draft.env}
                        onChange={(event) => setDraft({ ...draft, env: event.target.value })}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label htmlFor="mcp-url" className="block space-y-1 text-sm">
                      <span>URL</span>
                      <Input
                        id="mcp-url"
                        type="url"
                        value={draft.url}
                        onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                      />
                    </label>
                    <label htmlFor="mcp-headers" className="block space-y-1 text-sm">
                      <span>Headers (NAME=value, one per line)</span>
                      <Textarea
                        id="mcp-headers"
                        value={draft.headers}
                        onChange={(event) => setDraft({ ...draft, headers: event.target.value })}
                      />
                    </label>
                  </>
                )}
                {!validation.valid && draft.name.trim().length > 0 && (
                  <p role="alert" className="text-xs text-destructive">
                    {validation.errors.join(' ')}
                  </p>
                )}
              </div>
            )
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            {importMode ? (
              <Button type="button" disabled={saving} onClick={() => void saveImport()}>
                {saving ? 'Saving…' : 'Parse & Save'}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={!validation.valid || saving}
                onClick={() => void persistDraft()}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
