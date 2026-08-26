/**
 * Custom ACP Agent dialog (outside the registry) — paste-JSON import + export.
 *
 * A user pastes an `AgentConfig`-shaped JSON (`{ configId?, name, command,
 * args, env, allowTerminal, icon? }`, camelCase) — or a Zed-style
 * `agent_servers` / `acp.agents` / `agents` map-wrapped config, which is
 * unwrapped (name taken from the map key, `type`/`default_mode`/etc. dropped).
 * The dialog:
 *   1. parses + unwraps the JSON and rejects unknown fields (only the 7
 *      AgentConfig fields incl. `icon` are allowed);
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
 * camelCase JSON of just the `AgentConfig` fields incl. `icon` when present
 * (strips `id`/`templateId`) so it round-trips through this import validator.
 */

import { ClipboardPaste, Plus } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { IconPicker } from '@/components/agents/IconPicker'
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
import {
  looksLikeSecretValue,
  type StoredAgentConfig,
  validateAgentConfig
} from '@/lib/acp-agents-persistence'
import type { AgentConfig } from '@/lib/acp-api'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'

interface CustomAcpAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Fields allowed in a pasted AgentConfig JSON (camelCase), incl. `icon`. */
const ALLOWED_AGENT_CONFIG_FIELDS = new Set<string>([
  'configId',
  'name',
  'command',
  'args',
  'env',
  'allowTerminal',
  'icon'
])

/** Zed session-preference fields silently dropped on import (no Termul equivalent). */
const DROPPED_ZED_FIELDS = new Set([
  'type',
  'default_mode',
  'default_config_options',
  'favorite_config_option_values'
])

/** Max icon SVG string size (64KB) — matches the IconPicker upload cap. */
const MAX_ICON_BYTES = 64 * 1024

/** Top-level map wrapper keys accepted for paste normalization. */
const MAP_WRAPPER_KEYS = new Set(['agent_servers', 'agents'])

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
 * id/templateId). Includes `icon` when present. Throws if `configId` is
 * missing/empty — a saved custom agent always carries one after the load-time
 * backfill, but guard defensively so a corrupt store never emits a
 * non-round-trippable export.
 */
export function exportAgentConfig(stored: StoredAgentConfig): string {
  if (!stored.configId || stored.configId.trim().length === 0) {
    throw new Error(
      `cannot export agent "${stored.name}": configId missing; the saved config is corrupt`
    )
  }
  const exported: AgentConfig & { icon?: string } = {
    configId: stored.configId,
    name: stored.name,
    command: stored.command,
    args: stored.args,
    env: stored.env,
    allowTerminal: stored.allowTerminal
  }
  if (typeof stored.icon === 'string' && stored.icon.length > 0) {
    exported.icon = stored.icon
  }
  return JSON.stringify(exported, null, 2)
}

type ParsedConfig = {
  config: AgentConfig & { icon?: string }
  /** True when the paste carried a non-empty (post-trim) configId. */
  hadConfigId: boolean
  /** The pasted icon SVG (undefined when absent). */
  icon: string | undefined
}

/**
 * Unwrap a Zed-style map wrapper (`agent_servers` / `acp.agents` / `agents`).
 * Takes `name` from the map key. Returns the unwrapped entry object, or an
 * error string. When no wrapper is present, returns the original object.
 */
type UnwrapResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string }

/**
 * Unwrap a Zed-style map wrapper (`agent_servers` / `acp.agents` / `agents`).
 * Takes `name` from the map key. Returns the unwrapped entry object, or an
 * error string. When no wrapper is present, returns the original object.
 */
function unwrapMapWrapper(obj: Record<string, unknown>): UnwrapResult {
  // `acp.agents` dotted-key wrapper (flat VS Code form): { "acp.agents": { Name: { ... } } }
  if ('acp.agents' in obj) {
    const inner = obj['acp.agents']
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      return unwrapSingleEntry(inner as Record<string, unknown>)
    }
  }

  // `acp.agents` two-level wrapper: { acp: { agents: { Name: { ... } } } }
  if ('acp' in obj && obj.acp !== null && typeof obj.acp === 'object' && !Array.isArray(obj.acp)) {
    const acpObj = obj.acp as Record<string, unknown>
    if (
      acpObj.agents !== null &&
      typeof acpObj.agents === 'object' &&
      !Array.isArray(acpObj.agents)
    ) {
      return unwrapSingleEntry(acpObj.agents as Record<string, unknown>)
    }
  }

  // `agent_servers` / `agents` single-level wrapper. A real Zed settings
  // file carries sibling keys (session, theme, etc.) alongside `agent_servers`,
  // so locate the wrapper by name regardless of sibling keys.
  for (const wrapperKey of MAP_WRAPPER_KEYS) {
    if (wrapperKey in obj) {
      const inner = obj[wrapperKey]
      if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
        return unwrapSingleEntry(inner as Record<string, unknown>)
      }
    }
  }

  // No wrapper — bare object
  return { ok: true, value: obj }
}

function unwrapSingleEntry(inner: Record<string, unknown>): UnwrapResult {
  const entries = Object.entries(inner)
  if (entries.length === 0) return { ok: false, error: 'The agent map is empty.' }
  if (entries.length > 1) {
    return { ok: false, error: `Found ${entries.length} agent entries; paste one at a time.` }
  }
  const [name, entryObj] = entries[0]
  if (entryObj === null || typeof entryObj !== 'object' || Array.isArray(entryObj)) {
    return { ok: false, error: `Agent entry "${name}" must be a JSON object.` }
  }
  return { ok: true, value: { ...(entryObj as Record<string, unknown>), name } }
}

/**
 * Parse + validate the pasted JSON. Returns an error string on failure, or the
 * promoted `AgentConfig` on success. Unwraps Zed-style map wrappers first,
 * then only the 7 allowed fields (incl. `icon`) are permitted; unknown fields
 * (incl. `id`/`templateId`) are rejected loudly so the export shape
 * round-trips. A whitespace-only `configId` is rejected (rather than silently
 * trimmed to a fresh identity). Zed session-preference fields (`type`,
 * `default_mode`, etc.) are silently dropped before the allowed-fields check.
 */
function parsePastedAgentConfig(raw: string): ParsedConfig | { error: string } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { error: 'Paste an agent config JSON first.' }

  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch (err) {
    return { error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { error: 'Agent config must be a JSON object.' }
  }

  // Unwrap Zed-style map wrappers (agent_servers / acp.agents / agents).
  const unwrapped = unwrapMapWrapper(json as Record<string, unknown>)
  if (!unwrapped.ok) return { error: unwrapped.error }
  let obj: Record<string, unknown> = unwrapped.value

  // Reject registry/extension entries (they use the registry install flow,
  // not the custom-agent paste path).
  if (obj.type === 'registry' || obj.type === 'extension') {
    return {
      error:
        'registry/extension agent entries are not supported in the custom-agent dialog; use the registry install flow.'
    }
  }

  // Silently drop Zed session-preference fields before the allowed-fields
  // check so they don't trigger "Unknown field" errors. Single-pass filter.
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!DROPPED_ZED_FIELDS.has(key)) {
      filtered[key] = value
    }
  }
  obj = filtered

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_AGENT_CONFIG_FIELDS.has(key)) {
      return {
        error: `Unknown field "${key}". Only configId, name, command, args, env, allowTerminal, icon are allowed.`
      }
    }
  }

  // configId: a string is required when present; a whitespace-only value is
  // rejected (not silently trimmed) so the user keeps their intended namespace.
  if (obj.configId !== undefined && typeof obj.configId !== 'string') {
    return { error: 'configId must be a string.' }
  }
  const rawConfigId = typeof obj.configId === 'string' ? obj.configId : undefined
  if (rawConfigId !== undefined && rawConfigId.trim().length === 0) {
    return { error: 'configId cannot be empty or whitespace.' }
  }

  const args = obj.args
  const env = obj.env
  const allowTerminal = obj.allowTerminal
  // undefined is allowed (field optional); when present, must be the right
  // type. The shared `validateAgentConfig` covers element/value-type checks
  // too, but surface a clearer error here before constructing a typed object.
  if (args !== undefined && !Array.isArray(args)) return { error: 'args must be an array.' }
  if (args !== undefined && Array.isArray(args) && args.some((a) => typeof a !== 'string')) {
    return { error: 'args must be an array of strings.' }
  }
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
    return { error: 'env must be an object.' }
  }
  if (
    env !== undefined &&
    typeof env === 'object' &&
    env !== null &&
    Object.values(env).some((v) => typeof v !== 'string')
  ) {
    return { error: 'env values must be strings.' }
  }
  if (allowTerminal !== undefined && typeof allowTerminal !== 'boolean') {
    return { error: 'allowTerminal must be a boolean.' }
  }
  if (obj.icon !== undefined && typeof obj.icon !== 'string') {
    return { error: 'icon must be a string.' }
  }
  // Size cap + sanitize at ingress: a pasted icon bypasses the upload path's
  // 64KB guard, so enforce it here. Sanitize so no malformed/malicious SVG
  // is persisted to disk (symmetry with the upload path).
  let sanitizedIcon: string | undefined
  if (typeof obj.icon === 'string') {
    if (obj.icon.length > MAX_ICON_BYTES) {
      return { error: 'icon is too large (max 64KB).' }
    }
    const sanitized = sanitizeInlineAgentSvg(obj.icon)
    sanitizedIcon = sanitized ?? undefined
  }

  const cfg: AgentConfig & { icon?: string } = {
    configId: rawConfigId?.trim() || undefined,
    name: typeof obj.name === 'string' ? obj.name : '',
    command: typeof obj.command === 'string' ? obj.command : '',
    args: Array.isArray(args) ? (args as string[]) : [],
    env:
      env !== undefined && typeof env === 'object' && env !== null
        ? (env as Record<string, string>)
        : {},
    allowTerminal: typeof allowTerminal === 'boolean' ? allowTerminal : false,
    icon: sanitizedIcon
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
        error:
          `refusing to persist a raw secret for env "${key}" on agent "${cfg.name}"; ` +
          `store it in secure storage and reference it as $${key}`
      }
    }
  }

  return {
    config: cfg,
    hadConfigId: Boolean(cfg.configId && cfg.configId.length > 0),
    icon: cfg.icon
  }
}

export function CustomAcpAgentDialog({
  open,
  onOpenChange
}: CustomAcpAgentDialogProps): React.JSX.Element {
  const [jsonText, setJsonText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState<ConfirmStep>('idle')
  const [pendingConfig, setPendingConfig] = useState<StoredAgentConfig | null>(null)
  const [icon, setIcon] = useState('')
  const [iconTouched, setIconTouched] = useState(false)
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)

  const reset = useCallback(() => {
    setJsonText('')
    setError(null)
    setSaving(false)
    setStep('idle')
    setPendingConfig(null)
    setIcon('')
    setIconTouched(false)
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // Don't close or reset while a save is in-flight — the await
      // continuation must not run toast/onOpenChange after a mid-flight close.
      if (saving) return
      if (!next) {
        // Closing cancels any in-flight confirmation (no persistence). The
        // pasted JSON + icon are cleared so a fresh open starts clean.
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
      toast.success(`Agent "${stored.name}" saved`)
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
  }, [pendingConfig, saving, saveAgentConfig, reset, onOpenChange])

  const handleSave = useCallback(async () => {
    // Guard re-entry (double-click before the confirm step mounts).
    if (saving || step !== 'idle') return
    setError(null)
    const parsed = parsePastedAgentConfig(jsonText)
    if ('error' in parsed) {
      setError(parsed.error)
      return
    }
    const { config, hadConfigId, icon: parsedIcon } = parsed

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
    // Icon precedence: if the user interacted with the picker (incl. clearing
    // to "No icon"), the picker state wins — even when empty (clearing).
    // Otherwise fall back to the pasted icon, then the existing agent's icon.
    const resolvedIcon = iconTouched ? icon : parsedIcon || existing?.icon
    const stored: StoredAgentConfig = {
      ...config,
      configId,
      id,
      templateId: undefined,
      icon: resolvedIcon || undefined
    }

    // Sync the picker state from a pasted icon so the UI reflects the
    // pasted value (the picker shows the right selected-state ring).
    if (!iconTouched && parsedIcon) {
      setIcon(parsedIcon)
    }

    // Move into the in-dialog arbitrary-command confirmation step (CAP-3).
    // `allowTerminal: true` advances to a SECOND confirmation after the first.
    setPendingConfig(stored)
    setStep('confirm')
  }, [jsonText, saving, step, icon, iconTouched])

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
            {confirming ? 'Confirm arbitrary command' : 'Add Custom ACP Agent'}
          </DialogTitle>
          <DialogDescription>
            {confirming
              ? 'Persisting this agent will let it execute the configured command. Review it before confirming.'
              : 'Paste an ACP agent config as JSON (flat or Zed agent_servers format). Env values must be $VAR placeholders.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          {!confirming && (
            <>
              <div className="flex items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs">Icon</Label>
                  <IconPicker
                    value={icon}
                    onChange={(svg) => {
                      setIcon(svg)
                      setIconTouched(true)
                    }}
                  />
                </div>
              </div>
              <Label htmlFor="custom-acp-agent-json" className="text-xs">
                Agent config JSON
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
                Saved agents appear in the ACP launcher and reattach to their session on restart.
                Use Copy JSON on a saved agent to share it.
              </p>
            </>
          )}

          {confirming && pendingConfig && (
            <div className="space-y-3">
              <p className="text-sm text-destructive">
                {step === 'confirmTerminal'
                  ? ARBITRARY_COMMAND_TERMINAL_PROMPT
                  : ARBITRARY_COMMAND_PROMPT}
              </p>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs">
                <dt className="text-muted-foreground">name</dt>
                <dd className="truncate">{pendingConfig.name}</dd>
                <dt className="text-muted-foreground">command</dt>
                <dd className="truncate">{pendingConfig.command}</dd>
                <dt className="text-muted-foreground">args</dt>
                <dd className="truncate">{pendingConfig.args.join(' ') || '—'}</dd>
                <dt className="text-muted-foreground">configId</dt>
                <dd className="truncate">{pendingConfig.configId}</dd>
                {pendingConfig.allowTerminal === true && (
                  <>
                    <dt className="text-muted-foreground">allowTerminal</dt>
                    <dd className="text-amber-500">true</dd>
                  </>
                )}
              </dl>
              {step === 'confirmTerminal' && (
                <p className="text-2xs text-amber-500">
                  This is the second confirmation: terminal capability lets the agent run arbitrary
                  commands on your machine.
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
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || !jsonText.trim()}
              >
                {saving ? 'Saving…' : 'Save Agent'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={cancelConfirm} disabled={saving}>
                {step === 'confirmTerminal' ? 'Back' : 'Cancel'}
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
                  ? 'Saving…'
                  : step === 'confirmTerminal'
                    ? 'Confirm — Allow Terminal'
                    : 'Confirm — Execute Command'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
