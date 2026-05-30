import { useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Plus, Trash2 } from 'lucide-react'
import { useAcpStore } from '@/stores/acp-store'
import { secureStorageApi } from '@/lib/api'
import { looksLikeSecretValue } from '@/lib/acp-agents-persistence'
import {
  validateMcpServer,
  type McpTransport,
  type StoredMcpServer
} from '@/lib/acp-mcp-persistence'
import type { McpServerConfig } from '@/lib/acp-api'

interface McpServerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  existing?: StoredMcpServer
}

interface KvRow {
  name: string
  value: string
}

function existingKv(existing: StoredMcpServer | undefined, kind: 'env' | 'headers'): KvRow[] {
  if (!existing) return []
  const arr = (existing as unknown as Record<string, KvRow[] | undefined>)[kind]
  return Array.isArray(arr) ? arr.map((r) => ({ name: r.name, value: r.value })) : []
}

export function McpServerDialog({
  open,
  onOpenChange,
  existing
}: McpServerDialogProps): React.JSX.Element {
  const saveMcpServer = useAcpStore((s) => s.saveMcpServer)

  const [transport, setTransport] = useState<McpTransport>(
    (existing?.type as McpTransport) ?? 'stdio'
  )
  const [name, setName] = useState(existing?.name ?? '')
  const [command, setCommand] = useState(
    existing && (existing.type ?? 'stdio') === 'stdio' ? (existing as { command: string }).command : ''
  )
  const [args, setArgs] = useState<string[]>(
    existing && (existing.type ?? 'stdio') === 'stdio'
      ? ((existing as { args?: string[] }).args ?? [])
      : []
  )
  const [url, setUrl] = useState(
    existing && existing.type !== undefined && existing.type !== 'stdio'
      ? (existing as { url: string }).url
      : ''
  )
  const [env, setEnv] = useState<KvRow[]>(existingKv(existing, 'env'))
  const [headers, setHeaders] = useState<KvRow[]>(existingKv(existing, 'headers'))

  const validation = useMemo(
    () =>
      validateMcpServer(
        transport === 'stdio'
          ? { type: 'stdio', name, command }
          : { type: transport, name, url }
      ),
    [transport, name, command, url]
  )

  const persistSecrets = useCallback(
    async (rows: KvRow[], id: string, kind: string): Promise<KvRow[]> => {
      const out: KvRow[] = []
      for (const row of rows) {
        if (row.name.trim().length === 0) continue
        if (looksLikeSecretValue(row.value)) {
          const secretKey = `acp/mcp/${id}/${kind}/${row.name}`
          const res = await secureStorageApi.setSecret(secretKey, row.value)
          if (!res.success) throw new Error(`Failed to store secret ${row.name}: ${res.error ?? ''}`)
          out.push({ name: row.name, value: `$${row.name}` })
        } else {
          out.push({ name: row.name, value: row.value })
        }
      }
      return out
    },
    []
  )

  const handleSave = useCallback(async () => {
    if (!validation.valid) return
    const id = existing?.id ?? `mcp-${crypto.randomUUID()}`
    try {
      let config: McpServerConfig
      if (transport === 'stdio') {
        config = {
          type: 'stdio',
          name: name.trim(),
          command: command.trim(),
          args: args.filter((a) => a.length > 0),
          env: await persistSecrets(env, id, 'env')
        }
      } else {
        config = {
          type: transport,
          name: name.trim(),
          url: url.trim(),
          headers: await persistSecrets(headers, id, 'headers')
        }
      }
      await saveMcpServer({ id, ...config } as StoredMcpServer)
      toast.success(existing ? 'MCP server updated' : 'MCP server added')
      onOpenChange(false)
    } catch (err) {
      toast.error(`Failed to save MCP server: ${String(err)}`)
    }
  }, [validation.valid, existing, transport, name, command, args, url, env, headers, persistSecrets, saveMcpServer, onOpenChange])

  const kvEditor = (rows: KvRow[], setRows: (r: KvRow[]) => void, label: string): React.JSX.Element => (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      {rows.map((row, i) => (
        <div key={i} className="flex gap-1">
          <Input
            value={row.name}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
            placeholder="name"
            className="font-mono"
          />
          <Input
            value={row.value}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
            placeholder="value or $VAR"
            className="font-mono"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 w-fit text-[11px]"
        onClick={() => setRows([...rows, { name: '', value: '' }])}
      >
        <Plus size={12} /> Add
      </Button>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit MCP Server' : 'Add MCP Server'}</DialogTitle>
          <DialogDescription>Configure a Model Context Protocol server for agents to use.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Transport</Label>
            <Select value={transport} onValueChange={(v) => setTransport(v as McpTransport)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio</SelectItem>
                <SelectItem value="http">http</SelectItem>
                <SelectItem value="sse">sse</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="mcp-name" className="text-xs">
              Name
            </Label>
            <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" />
          </div>

          {transport === 'stdio' ? (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="mcp-command" className="text-xs">
                  Command
                </Label>
                <Input
                  id="mcp-command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className="font-mono"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs">Arguments</Label>
                {args.map((arg, i) => (
                  <div key={i} className="flex gap-1">
                    <Input
                      value={arg}
                      onChange={(e) => setArgs(args.map((a, j) => (j === i ? e.target.value : a)))}
                      className="font-mono"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0"
                      onClick={() => setArgs(args.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 w-fit text-[11px]"
                  onClick={() => setArgs([...args, ''])}
                >
                  <Plus size={12} /> Add argument
                </Button>
              </div>
              {kvEditor(env, setEnv, 'Environment Variables')}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="mcp-url" className="text-xs">
                  URL
                </Label>
                <Input
                  id="mcp-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://api.example.com/mcp"
                  className="font-mono"
                />
              </div>
              {kvEditor(headers, setHeaders, 'Headers')}
            </>
          )}

          <p className="text-[10px] text-muted-foreground">
            Secret-looking values are saved to OS secure storage; only a $PLACEHOLDER is persisted.
            HTTP/SSE require agent support (mcpCapabilities) and may be ignored otherwise.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={!validation.valid}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
