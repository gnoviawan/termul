import { useState } from 'react'
import { toast } from 'sonner'
import { McpServerForm } from '@/components/settings/McpServerForm'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import type { McpServerConfig } from '@/lib/acp-api'
import { type StoredMcpServer, sameLaunch, transportOf } from '@/lib/acp-mcp-persistence'
import { logFrontendError } from '@/lib/log-api'
import { parseMcpJsonImport } from '@/lib/mcp-json-import'
import {
  type DraftErrors,
  draftFromServer,
  draftToConfig,
  draftToUncheckedConfig,
  emptyDraft,
  type McpServerDraft
} from '@/lib/mcp-server-draft'
import { randomUUID } from '@/lib/uuid'
import { useAcpStore } from '@/stores/acp-store'

type McpDialogTarget = { mode: 'add' } | { mode: 'edit'; server: StoredMcpServer }

type McpDialogView =
  | { view: 'form'; showErrors: boolean }
  | { view: 'json'; text: string; errors: string[] }

type McpDialogState = McpDialogTarget & McpDialogView & { draft: McpServerDraft }

const LOG_SOURCE = 'settings.McpServersSettings'
const FORM_ID = 'mcp-server-form'

const trustNote = (
  <p className="text-xs text-muted-foreground">
    Only add servers from developers you trust. A server's tools can read and change things on your
    behalf, and Termul can't check what they do.
  </p>
)

function targetOf(state: McpDialogState): McpDialogTarget {
  return state.mode === 'add' ? { mode: 'add' } : { mode: 'edit', server: state.server }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function logMcpJsonRejection(errors: string[]): void {
  void logFrontendError({
    level: 'warn',
    source: LOG_SOURCE,
    message: `MCP server JSON rejected: ${errors.join(' | ')}`
  })
}

const FORM_NEEDS_ONE_SERVER = 'The form holds one valid server. Fix the JSON, or save it from here.'

function isBlankDraft(draft: McpServerDraft): boolean {
  return (
    draft.name.trim() === '' &&
    draft.remote.url.trim() === '' &&
    draft.local.commandLine.trim() === ''
  )
}

function jsonEnabled(text: string): boolean | undefined {
  try {
    const raw: unknown = JSON.parse(text)
    return isRecord(raw) && typeof raw.enabled === 'boolean' ? raw.enabled : undefined
  } catch {
    return undefined
  }
}

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

export function useMcpServerDialog(): {
  openAdd: () => void
  openEdit: (server: StoredMcpServer) => void
  element: React.JSX.Element
} {
  const saveMcpServer = useAcpStore((state) => state.saveMcpServer)
  const importMcpServers = useAcpStore((state) => state.importMcpServers)
  const [dialog, setDialog] = useState<McpDialogState | null>(null)
  const [saving, setSaving] = useState(false)

  const closeDialog = (): void => setDialog(null)

  const openAdd = (): void =>
    setDialog({ mode: 'add', view: 'form', showErrors: false, draft: emptyDraft() })

  const openEdit = (server: StoredMcpServer): void =>
    setDialog({
      mode: 'edit',
      server,
      view: 'form',
      showErrors: false,
      draft: draftFromServer(server)
    })

  const setDraft = (draft: McpServerDraft): void =>
    setDialog((prev) => (prev ? { ...prev, draft } : prev))

  const setJsonText = (text: string): void =>
    setDialog((prev) => (prev?.view === 'json' ? { ...prev, text } : prev))

  const setJsonErrors = (errors: string[]): void =>
    setDialog((prev) => (prev?.view === 'json' ? { ...prev, errors } : prev))

  const showJson = (state: McpDialogState): void => {
    const config = draftToUncheckedConfig(state.draft)
    const text =
      state.mode === 'edit'
        ? serverToJson({ ...config, id: state.server.id, enabled: state.server.enabled })
        : isBlankDraft(state.draft)
          ? ''
          : serverToJson({ ...config, id: '' })
    setDialog({ ...targetOf(state), view: 'json', text, errors: [], draft: state.draft })
  }

  const showForm = (state: McpDialogState & { view: 'json' }): void => {
    let draft = state.draft
    if (state.text.trim() !== '') {
      const { servers: parsed, errors } = parseMcpJsonImport(state.text)
      if (errors.length > 0 || parsed.length !== 1 || !parsed[0]) {
        setJsonErrors([FORM_NEEDS_ONE_SERVER])
        return
      }
      draft = draftFromServer({ ...parsed[0], id: '' })
    }
    const enabled = jsonEnabled(state.text)
    const target =
      state.mode === 'edit' && enabled !== undefined
        ? { mode: 'edit' as const, server: { ...state.server, enabled } }
        : targetOf(state)
    setDialog({ ...target, view: 'form', showErrors: false, draft })
  }

  const logSaveFailure = (mode: McpDialogTarget['mode']): void => {
    void logFrontendError({
      level: 'error',
      source: LOG_SOURCE,
      message: `MCP server ${mode} failed to save; the store rolled back`
    })
  }

  const commitAdd = async (configs: McpServerConfig[]): Promise<void> => {
    const batch = configs.map((config) => ({ ...config, id: randomUUID(), enabled: true }))
    try {
      await importMcpServers(batch)
      toast.success(`Added ${batch.length} MCP server${batch.length === 1 ? '' : 's'}`)
      closeDialog()
    } catch {
      logSaveFailure('add')
      toast.error('Could not save the MCP servers. Your previous settings were restored.')
    }
  }

  const commitEdit = async (
    target: StoredMcpServer,
    config: McpServerConfig,
    enabled: boolean
  ): Promise<void> => {
    try {
      await saveMcpServer({
        ...config,
        id: target.id,
        enabled,
        ...(target.catalog && sameLaunch(target, config) ? { catalog: target.catalog } : {})
      })
      toast.success('MCP server updated')
      closeDialog()
    } catch {
      logSaveFailure('edit')
      toast.error('Could not save the MCP server. Your previous settings were restored.')
    }
  }

  const saveAdd = async (jsonText: string): Promise<void> => {
    const { servers: parsedServers, errors } = parseMcpJsonImport(jsonText)
    if (errors.length > 0) {
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
    await commitAdd(parsedServers)
  }

  const saveEdit = async (target: StoredMcpServer, jsonText: string): Promise<void> => {
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
    } catch {}
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
    await commitEdit(target, parsed, explicitEnabled ?? target.enabled ?? true)
  }

  const saveJson = async (state: McpDialogState & { view: 'json' }): Promise<void> => {
    if (state.text.trim().length === 0) return
    setSaving(true)
    setJsonErrors([])
    try {
      if (state.mode === 'add') await saveAdd(state.text)
      else await saveEdit(state.server, state.text)
    } finally {
      setSaving(false)
    }
  }

  const saveForm = async (state: McpDialogState & { view: 'form' }): Promise<void> => {
    const result = draftToConfig(state.draft)
    if ('errors' in result) {
      void logFrontendError({
        level: 'warn',
        source: LOG_SOURCE,
        message: `MCP server form rejected: ${Object.keys(result.errors).join(', ')}`
      })
      setDialog((prev) => (prev?.view === 'form' ? { ...prev, showErrors: true } : prev))
      return
    }
    setSaving(true)
    try {
      if (state.mode === 'add') await commitAdd([result.config])
      else await commitEdit(state.server, result.config, state.server.enabled ?? true)
    } finally {
      setSaving(false)
    }
  }

  const formResult =
    dialog?.view === 'form' && dialog.showErrors ? draftToConfig(dialog.draft) : null
  const formErrors: DraftErrors = formResult && 'errors' in formResult ? formResult.errors : {}

  return {
    openAdd,
    openEdit,
    element: (
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !saving) closeDialog()
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          {dialog?.view === 'form' ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog.mode === 'edit' ? 'Edit MCP server' : 'Add MCP server'}
                </DialogTitle>
                <DialogDescription>
                  {dialog.mode === 'edit'
                    ? 'Change how Termul reaches this server.'
                    : 'Where does this server run? The setup page or README usually tells you.'}
                </DialogDescription>
              </DialogHeader>
              <McpServerForm
                formId={FORM_ID}
                draft={dialog.draft}
                errors={formErrors}
                onChange={setDraft}
                onSubmit={() => void saveForm(dialog)}
              />
              {dialog.mode === 'add' ? trustNote : null}
              <DialogFooter className="gap-2 sm:items-center sm:space-x-0">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 sm:mr-auto"
                  disabled={saving}
                  onClick={() => showJson(dialog)}
                >
                  {dialog.mode === 'edit' ? 'Edit as JSON' : 'Import JSON instead'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={closeDialog}
                >
                  Cancel
                </Button>
                <Button type="submit" form={FORM_ID} size="sm" disabled={saving}>
                  {saving ? 'Saving…' : dialog.mode === 'edit' ? 'Save' : 'Add server'}
                </Button>
              </DialogFooter>
            </>
          ) : dialog?.view === 'json' ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog.mode === 'edit' ? 'Edit MCP server' : 'Add MCP servers'}
                </DialogTitle>
                <DialogDescription>
                  {dialog.mode === 'edit'
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
                    value={dialog.text}
                    onChange={(event) => setJsonText(event.target.value)}
                    placeholder='{"mcpServers": {"dokploy": {"command": "npx", "args": ["-y", "@dokploy/mcp"], "env": {"DOKPLOY_URL": "..."}}}}'
                    className="font-mono"
                  />
                </label>
                {dialog.errors.length > 0 && (
                  <ul role="alert" className="space-y-1 text-xs text-destructive">
                    {dialog.errors.map((error) => (
                      <li key={error} className="break-words font-mono">
                        {error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {dialog.mode === 'add' ? trustNote : null}
              <DialogFooter className="gap-2 sm:items-center sm:space-x-0">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 sm:mr-auto"
                  disabled={saving}
                  onClick={() => showForm(dialog)}
                >
                  Use the form
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={closeDialog}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={dialog.text.trim().length === 0 || saving}
                  onClick={() => void saveJson(dialog)}
                >
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    )
  }
}
