/**
 * Custom ACP Agent dialog (outside the registry) — paste-JSON import + export.
 *
 * A user pastes an `AgentConfig`-shaped JSON (`{ configId?, name, command,
 * args, env, allowTerminal }`, camelCase). The dialog:
 *   1. parses the JSON and rejects unknown fields (only the 6 AgentConfig
 *      fields are allowed);
 *   2. runs `validateAgentConfig` (shape, incl. args/env element types) +
 *      `looksLikeSecretValue` per env value (no raw secrets on disk);
 *   3. assigns `id`=`custom-<uuid8>` (or reuses an existing config's `id` when
 *      a config with the same `configId` is already saved — so re-paste
 *      updates instead of duplicating) and `configId`=`pasted ?? custom-<uuid8>`;
 *   4. shows an in-dialog arbitrary-command confirmation (a second one when
 *      `allowTerminal: true`) — no persistence path bypasses confirmation;
 *   5. saves via `useAcpStore.saveAgentConfig`.
 *
 * Export (`Copy JSON`) serializes a `StoredAgentConfig` back to pretty
 * camelCase JSON of just the 6 `AgentConfig` fields (strips `id`/`templateId`)
 * so it round-trips through this import validator.
 */

import { ClipboardPaste, Plus } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { runtimeT } from '@/i18n/runtime'
import { useRuntimeTranslation } from '@/i18n/use-runtime-translation'
import {
  looksLikeSecretValue,
  type StoredAgentConfig,
  validateAgentConfig
} from '@/lib/acp-agents-persistence'
import type { AgentConfig } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'

interface CustomAcpAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Fields allowed in a pasted AgentConfig JSON (camelCase). */
const ALLOWED_AGENT_CONFIG_FIELDS = new Set<keyof AgentConfig>([
  'configId',
  'name',
  'command',
  'args',
  'env',
  'allowTerminal'
])

const ARBITRARY_COMMAND_PROMPT =
  'This will execute an arbitrary command on your machine. Are you sure you want to persist this agent?'
const ARBITRARY_COMMAND_TERMINAL_PROMPT =
  'This agent requests the ACP terminal capability, which allows it to execute arbitrary commands on your machine. Are you sure you want to allow this?'

type ConfirmStep = 'idle' | 'confirm' | 'confirmTerminal'

/** Generate a fresh `custom-<uuid8>` identity. */
function freshCustomId(): string {
  return `custom-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Serialize a stored custom agent to exportable AgentConfig JSON (no
 * id/templateId). Throws if `configId` is missing/empty — a saved custom agent
 * always carries one after the load-time backfill, but guard defensively so a
 * corrupt store never emits a non-round-trippable export.
 */
export function exportAgentConfig(stored: StoredAgentConfig): string {
  if (!stored.configId || stored.configId.trim().length === 0) {
    throw new Error(
      `cannot export agent "${stored.name}": configId missing; the saved config is corrupt`
    )
  }
  const exported: AgentConfig = {
    configId: stored.configId,
    name: stored.name,
    command: stored.command,
    args: stored.args,
    env: stored.env,
    allowTerminal: stored.allowTerminal
  }
  return JSON.stringify(exported, null, 2)
}

type ParsedConfig = {
  config: AgentConfig
  /** True when the paste carried a non-empty (post-trim) configId. */
  hadConfigId: boolean
}

/**
 * Parse + validate the pasted JSON. Returns an error string on failure, or the
 * promoted `AgentConfig` on success. Only the 6 AgentConfig fields are
 * permitted; unknown fields (incl. `id`/`templateId`) are rejected loudly so
 * the export shape round-trips. A whitespace-only `configId` is rejected
 * (rather than silently trimmed to a fresh identity).
 */
function parsePastedAgentConfig(raw: string): ParsedConfig | { error: string } {
  const t = (key: string, fallback: string, values?: Record<string, unknown>) =>
    runtimeT('agents', key, fallback, values)
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return { error: t('customAcp.errors.pasteFirst', 'Paste an agent config JSON first.') }
  }

  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch (err) {
    return {
      error: t('customAcp.errors.invalidJson', 'Invalid JSON: {{message}}', {
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { error: t('customAcp.errors.objectRequired', 'Agent config must be a JSON object.') }
  }
  const obj = json as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_AGENT_CONFIG_FIELDS.has(key as keyof AgentConfig)) {
      return {
        error: t(
          'customAcp.errors.unknownField',
          'Unknown field "{{field}}". Only configId, name, command, args, env, allowTerminal are allowed.',
          { field: key }
        )
      }
    }
  }

  // configId: a string is required when present; a whitespace-only value is
  // rejected (not silently trimmed) so the user keeps their intended namespace.
  if (obj.configId !== undefined && typeof obj.configId !== 'string') {
    return { error: t('customAcp.errors.configIdString', 'configId must be a string.') }
  }
  const rawConfigId = typeof obj.configId === 'string' ? obj.configId : undefined
  if (rawConfigId !== undefined && rawConfigId.trim().length === 0) {
    return { error: t('customAcp.errors.configIdBlank', 'configId cannot be empty or whitespace.') }
  }

  const args = obj.args
  const env = obj.env
  const allowTerminal = obj.allowTerminal
  // undefined is allowed (field optional); when present, must be the right
  // type. The shared `validateAgentConfig` covers element/value-type checks
  // too, but surface a clearer error here before constructing a typed object.
  if (args !== undefined && !Array.isArray(args)) {
    return { error: t('customAcp.errors.argsArray', 'args must be an array.') }
  }
  if (args !== undefined && Array.isArray(args) && args.some((a) => typeof a !== 'string')) {
    return { error: t('customAcp.errors.argsStrings', 'args must be an array of strings.') }
  }
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
    return { error: t('customAcp.errors.envObject', 'env must be an object.') }
  }
  if (
    env !== undefined &&
    typeof env === 'object' &&
    env !== null &&
    Object.values(env).some((v) => typeof v !== 'string')
  ) {
    return { error: t('customAcp.errors.envStrings', 'env values must be strings.') }
  }
  if (allowTerminal !== undefined && typeof allowTerminal !== 'boolean') {
    return {
      error: t('customAcp.errors.allowTerminalBoolean', 'allowTerminal must be a boolean.')
    }
  }

  const cfg: AgentConfig = {
    configId: rawConfigId?.trim() || undefined,
    name: typeof obj.name === 'string' ? obj.name : '',
    command: typeof obj.command === 'string' ? obj.command : '',
    args: Array.isArray(args) ? (args as string[]) : [],
    env:
      env !== undefined && typeof env === 'object' && env !== null
        ? (env as Record<string, string>)
        : {},
    allowTerminal: typeof allowTerminal === 'boolean' ? allowTerminal : false
  }

  // Shape validation (non-empty name/command + element/value types) — reuse
  // the shared validator so the dialog and the persistence layer agree on what
  // counts as valid.
  const shape = validateAgentConfig(cfg)
  if (!shape.valid) return { error: shape.errors.join(' ') }

  // Secret rejection: env values must be `$VAR` placeholders, never raw
  // literals. Surface a directed message (OS secure storage + `$VAR`).
  for (const [key, value] of Object.entries(cfg.env)) {
    if (looksLikeSecretValue(value)) {
      return {
        error: t(
          'customAcp.errors.rawSecret',
          'refusing to persist a raw secret for env "{{key}}" on agent "{{name}}"; store it in secure storage and reference it as ${{key}}',
          { key, name: cfg.name }
        )
      }
    }
  }

  return { config: cfg, hadConfigId: Boolean(cfg.configId && cfg.configId.length > 0) }
}

export function CustomAcpAgentDialog({
  open,
  onOpenChange
}: CustomAcpAgentDialogProps): React.JSX.Element {
  const t = useRuntimeTranslation('agents')
  const [jsonText, setJsonText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState<ConfirmStep>('idle')
  const [pendingConfig, setPendingConfig] = useState<StoredAgentConfig | null>(null)
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)

  const reset = useCallback(() => {
    setJsonText('')
    setError(null)
    setSaving(false)
    setStep('idle')
    setPendingConfig(null)
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Don't close or reset while a save is in-flight — the await
      // continuation must not run toast/onOpenChange after a mid-flight close.
      if (saving) return
      if (!next) {
        // Closing cancels any in-flight confirmation (no persistence). The
        // pasted JSON is cleared so a fresh open starts clean.
        reset()
      }
      onOpenChange(next)
    },
    [onOpenChange, reset, saving]
  )

  const performSave = useCallback(async () => {
    const stored = pendingConfig
    if (!stored || saving) return
    setSaving(true)
    try {
      await saveAgentConfig(stored)
      toast.success(t('customAcp.saved', 'Agent "{{name}}" saved', { name: stored.name }))
      reset()
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Log the save boundary failure (no env values in the log line).
      void logFrontendError({
        level: 'error',
        source: 'CustomAcpAgentDialog:saveAgentConfig',
        message: `Failed to save custom agent "${stored.name}": ${message}`
      })
      setError(message)
      setStep('idle')
      setPendingConfig(null)
    } finally {
      setSaving(false)
    }
  }, [pendingConfig, saving, saveAgentConfig, reset, onOpenChange, t])

  const handleSave = useCallback(async () => {
    // Guard re-entry (double-click before the confirm step mounts).
    if (saving || step !== 'idle') return
    setError(null)
    const parsed = parsePastedAgentConfig(jsonText)
    if ('error' in parsed) {
      setError(parsed.error)
      return
    }
    const { config, hadConfigId } = parsed

    // PATCH 3: re-paste of an exported config updates the existing agent
    // instead of creating a duplicate. If a config with this configId is
    // already saved, reuse its `id` so `saveAgentConfig` upserts (updates
    // name/command/args/env/allowTerminal) rather than appending a second row.
    const configId = hadConfigId && config.configId ? config.configId : freshCustomId()
    const existing = useAcpStore
      .getState()
      .agentConfigs.find((c) => (c.configId ?? c.id) === configId)
    // `id` (local persistence key) vs `configId` (stable namespace key):
    //   - existing config found → reuse its id (upsert)
    //   - configId pasted, no existing → fresh `custom-<uuid8>` id (configId honored)
    //   - no configId pasted, no existing → id == configId (one fresh identity)
    const id = existing ? existing.id : hadConfigId ? freshCustomId() : configId
    const stored: StoredAgentConfig = {
      ...config,
      configId,
      id,
      templateId: undefined
    }

    // Move into the in-dialog arbitrary-command confirmation step (CAP-3).
    // `allowTerminal: true` advances to a SECOND confirmation after the first.
    setPendingConfig(stored)
    setStep('confirm')
  }, [jsonText, saving, step])

  const handleConfirmArbitrary = useCallback(() => {
    if (!pendingConfig || saving) return
    if (pendingConfig.allowTerminal === true) {
      setStep('confirmTerminal')
    } else {
      void performSave()
    }
  }, [pendingConfig, saving, performSave])

  const cancelConfirm = useCallback(() => {
    if (saving) return
    setStep('idle')
    setPendingConfig(null)
    setError(null)
  }, [saving])

  const confirming = step === 'confirm' || step === 'confirmTerminal'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus size={18} />
            {confirming
              ? t('customAcp.confirmTitle', 'Confirm arbitrary command')
              : t('customAcp.title', 'Add Custom ACP Agent')}
          </DialogTitle>
          <DialogDescription>
            {confirming
              ? t(
                  'customAcp.confirmDescription',
                  'Persisting this agent will let it execute the configured command. Review it before confirming.'
                )
              : t(
                  'customAcp.description',
                  'Paste an ACP agent config as JSON. Only configId, name, command, args, env, and allowTerminal fields are accepted; env values must be $VAR placeholders.'
                )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          {!confirming && (
            <>
              <Label htmlFor="custom-acp-agent-json" className="text-xs">
                {t('customAcp.jsonLabel', 'Agent config JSON')}
              </Label>
              <Textarea
                id="custom-acp-agent-json"
                value={jsonText}
                onChange={(e) => {
                  setJsonText(e.target.value)
                  if (error) setError(null)
                }}
                placeholder={
                  '{\n  "name": "Internal Helper",\n  "command": "node",\n  "args": ["/path/to/agent.js"],\n  "env": { "API_KEY": "$INTERNAL_API_KEY" }\n}'
                }
                className="min-h-[160px] font-mono text-xs"
                spellCheck={false}
                disabled={saving}
                aria-invalid={error !== null}
              />
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
              <p className="text-2xs text-muted-foreground">
                <ClipboardPaste size={12} className="mr-1 inline-block" />
                {t(
                  'customAcp.savedHint',
                  'Saved agents appear in the ACP launcher and reattach to their session on restart. Use Copy JSON on a saved agent to share it.'
                )}
              </p>
            </>
          )}

          {confirming && pendingConfig && (
            <div className="space-y-3">
              <p className="text-sm text-destructive">
                {step === 'confirmTerminal'
                  ? t('customAcp.terminalPrompt', ARBITRARY_COMMAND_TERMINAL_PROMPT)
                  : t('customAcp.arbitraryCommandPrompt', ARBITRARY_COMMAND_PROMPT)}
              </p>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs">
                <dt className="text-muted-foreground">{t('customAcp.fields.name', 'Name')}</dt>
                <dd className="truncate">{pendingConfig.name}</dd>
                <dt className="text-muted-foreground">
                  {t('customAcp.fields.command', 'Command')}
                </dt>
                <dd className="truncate">{pendingConfig.command}</dd>
                <dt className="text-muted-foreground">{t('customAcp.fields.args', 'Arguments')}</dt>
                <dd className="truncate">
                  {pendingConfig.args.join(' ') || t('customAcp.fields.empty', '—')}
                </dd>
                <dt className="text-muted-foreground">
                  {t('customAcp.fields.configId', 'Config ID')}
                </dt>
                <dd className="truncate">{pendingConfig.configId}</dd>
                {pendingConfig.allowTerminal === true && (
                  <>
                    <dt className="text-muted-foreground">
                      {t('customAcp.fields.allowTerminal', 'Allow terminal')}
                    </dt>
                    <dd className="text-amber-500">true</dd>
                  </>
                )}
              </dl>
              {step === 'confirmTerminal' && (
                <p className="text-2xs text-amber-500">
                  {t(
                    'customAcp.terminalSecondConfirmation',
                    'This is the second confirmation: terminal capability lets the agent run arbitrary commands on your machine.'
                  )}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          {!confirming ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleOpenChange(false)}
                disabled={saving}
              >
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || !jsonText.trim()}
              >
                {saving ? t('common.saving', 'Saving…') : t('customAcp.saveAgent', 'Save Agent')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={cancelConfirm} disabled={saving}>
                {step === 'confirmTerminal'
                  ? t('common.back', 'Back')
                  : t('common.cancel', 'Cancel')}
              </Button>
              <Button
                size="sm"
                variant={step === 'confirmTerminal' ? 'destructive' : 'default'}
                onClick={
                  step === 'confirmTerminal' ? () => void performSave() : handleConfirmArbitrary
                }
                disabled={saving}
              >
                {saving
                  ? t('common.saving', 'Saving…')
                  : step === 'confirmTerminal'
                    ? t('customAcp.confirmTerminal', 'Confirm — Allow Terminal')
                    : t('customAcp.confirmExecute', 'Confirm — Execute Command')}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
