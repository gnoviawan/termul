import { CheckCircle2, Loader2, Plus, Trash2, XCircle } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  looksLikeSecretValue,
  type StoredAgentConfig,
  validateAgentConfig
} from '@/lib/acp-agents-persistence'
import type { AgentConfig } from '@/lib/acp-api'
import { secureStorageApi } from '@/lib/api'
import { useAcpStore } from '@/stores/acp-store'
import { AGENT_TEMPLATES, templateById } from './agent-templates'

interface AgentConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Existing config to edit; omit to add a new one. */
  existing?: StoredAgentConfig
}

interface EnvRow {
  key: string
  value: string
}

function toEnvRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([key, value]) => ({ key, value }))
}

type TestState = { status: 'idle' | 'testing' | 'ok' | 'fail'; message?: string }

export function AgentConfigDialog({
  open,
  onOpenChange,
  existing
}: AgentConfigDialogProps): React.JSX.Element {
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const testConnection = useAcpStore((s) => s.testConnection)

  const [name, setName] = useState(existing?.name ?? '')
  const [command, setCommand] = useState(existing?.command ?? '')
  const [args, setArgs] = useState<string[]>(existing?.args ?? [])
  const [envRows, setEnvRows] = useState<EnvRow[]>(toEnvRows(existing?.env ?? {}))
  const [allowTerminal, setAllowTerminal] = useState<boolean>(existing?.allowTerminal ?? false)
  const [templateId, setTemplateId] = useState<string | undefined>(existing?.templateId)
  const [test, setTest] = useState<TestState>({ status: 'idle' })

  const applyTemplate = useCallback((id: string) => {
    const t = templateById(id)
    if (!t) return
    setTemplateId(id === 'custom' ? undefined : id)
    setName(t.config.name)
    setCommand(t.config.command)
    setArgs(t.config.args)
    setEnvRows(toEnvRows(t.config.env))
    setAllowTerminal(t.config.allowTerminal ?? false)
    setTest({ status: 'idle' })
  }, [])

  const buildConfig = useCallback((): AgentConfig => {
    const env: Record<string, string> = {}
    for (const row of envRows) {
      if (row.key.trim().length > 0) env[row.key.trim()] = row.value
    }
    return {
      name: name.trim(),
      command: command.trim(),
      args: args.filter((a) => a.length > 0),
      env,
      allowTerminal
    }
  }, [name, command, args, envRows, allowTerminal])

  const validation = useMemo(() => validateAgentConfig({ name, command }), [name, command])

  /**
   * Persist secret-looking env values to OS secure storage and replace them with
   * a $PLACEHOLDER so the agents JSON never holds a raw secret.
   */
  const sanitizeEnvForPersistence = useCallback(
    async (config: AgentConfig, configId: string): Promise<AgentConfig> => {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(config.env)) {
        if (looksLikeSecretValue(value)) {
          const secretKey = `acp/${configId}/${key}`
          const res = await secureStorageApi.setSecret(secretKey, value)
          if (!res.success) {
            throw new Error(`Failed to store secret for ${key}: ${res.error ?? 'unknown error'}`)
          }
          env[key] = `$${key}`
        } else {
          env[key] = value
        }
      }
      return { ...config, env }
    },
    []
  )

  const handleSave = useCallback(async () => {
    if (!validation.valid) return
    const id = existing?.id ?? `agent-${crypto.randomUUID()}`
    try {
      const config = buildConfig()
      const sanitized = await sanitizeEnvForPersistence(config, id)
      const stored: StoredAgentConfig = { id, templateId, ...sanitized }
      await saveAgentConfig(stored)
      toast.success(existing ? 'Agent updated' : 'Agent added')
      onOpenChange(false)
    } catch (err) {
      toast.error(`Failed to save agent: ${String(err)}`)
    }
  }, [
    validation.valid,
    existing,
    templateId,
    buildConfig,
    sanitizeEnvForPersistence,
    saveAgentConfig,
    onOpenChange
  ])

  const handleTest = useCallback(async () => {
    if (!validation.valid) return
    setTest({ status: 'testing' })
    try {
      const caps = await testConnection(buildConfig())
      const capList = caps
        ? Object.entries(caps)
            .filter(([, v]) => v === true)
            .map(([k]) => k)
            .join(', ')
        : ''
      setTest({
        status: 'ok',
        message: capList ? `Connected. Capabilities: ${capList}` : 'Connected.'
      })
    } catch (err) {
      setTest({ status: 'fail', message: String(err) })
    }
  }, [validation.valid, buildConfig, testConnection])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit Agent' : 'Add Agent'}</DialogTitle>
          <DialogDescription>Configure an ACP agent to chat with.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {!existing && (
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Template</Label>
              <div className="flex flex-wrap gap-1">
                {AGENT_TEMPLATES.map((t) => (
                  <Button
                    key={t.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-[11px]"
                    onClick={() => applyTemplate(t.id)}
                  >
                    {t.icon && <t.icon width={12} height={12} />}
                    {t.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <Label htmlFor="acp-name" className="text-xs">
              Name
            </Label>
            <Input
              id="acp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Gemini CLI"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="acp-command" className="text-xs">
              Command
            </Label>
            <Input
              id="acp-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="gemini"
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
                  aria-label={`Remove argument ${i + 1}`}
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

          <div className="flex flex-col gap-1">
            <Label className="text-xs">Environment Variables</Label>
            {envRows.map((row, i) => (
              <div key={i} className="flex gap-1">
                <Input
                  value={row.key}
                  onChange={(e) =>
                    setEnvRows(envRows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
                  }
                  placeholder="KEY"
                  className="font-mono"
                />
                <Input
                  value={row.value}
                  onChange={(e) =>
                    setEnvRows(
                      envRows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r))
                    )
                  }
                  placeholder="value or $VAR"
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  aria-label={`Remove environment variable ${i + 1}`}
                  onClick={() => setEnvRows(envRows.filter((_, j) => j !== i))}
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
              onClick={() => setEnvRows([...envRows, { key: '', value: '' }])}
            >
              <Plus size={12} /> Add variable
            </Button>
            <p className="text-[10px] text-muted-foreground">
              Secret-looking values are saved to OS secure storage; only a $PLACEHOLDER is
              persisted.
            </p>
          </div>

          <label className="flex items-start gap-2 rounded-md border border-border/60 p-2">
            <input
              type="checkbox"
              checked={allowTerminal}
              onChange={(e) => setAllowTerminal(e.target.checked)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="text-xs font-medium">Allow terminal access</span>
              <span className="text-[10px] text-muted-foreground">
                Lets this agent run shell commands on your machine. Off by default — enable only for
                agents you trust.
              </span>
            </span>
          </label>

          {test.status !== 'idle' && (
            <div className="flex items-center gap-1.5 text-xs">
              {test.status === 'testing' && <Loader2 size={13} className="animate-spin" />}
              {test.status === 'ok' && <CheckCircle2 size={13} className="text-green-500" />}
              {test.status === 'fail' && <XCircle size={13} className="text-red-500" />}
              <span className={test.status === 'fail' ? 'text-red-400' : 'text-muted-foreground'}>
                {test.message ?? (test.status === 'testing' ? 'Testing…' : '')}
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleTest}
            disabled={!validation.valid || test.status === 'testing'}
          >
            Test Connection
          </Button>
          <Button type="button" onClick={handleSave} disabled={!validation.valid}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
