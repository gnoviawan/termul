/**
 * Persistence + validation for user-configured ACP agents.
 *
 * Agent configs are stored under a dedicated `persistenceApi` key (versioned
 * JSON) — deliberately NOT in the flat `AppSettings`. Raw secret values are
 * never written here; env values may hold `$VAR` placeholders whose real value
 * lives in OS secure storage.
 */

import type { AgentConfig } from '@/lib/acp-api'
import { persistenceApi } from '@/lib/api'

export const ACP_AGENTS_KEY = 'acp/agents'

/** A persisted agent config carries a stable local id. */
export interface StoredAgentConfig extends AgentConfig {
  id: string
  /** The template id this agent was created from (used to resolve an icon). */
  templateId?: string
  /** Inline SVG markup for a custom (bundled or uploaded) agent icon. */
  icon?: string
}

export interface AgentConfigValidation {
  valid: boolean
  errors: string[]
}

/** Validate a config for saving: non-empty name and command are required. */
export function validateAgentConfig(cfg: Partial<AgentConfig>): AgentConfigValidation {
  const errors: string[] = []
  if (!cfg.name || cfg.name.trim().length === 0) errors.push('Name is required.')
  if (!cfg.command || cfg.command.trim().length === 0) errors.push('Command is required.')
  if (cfg.args !== undefined) {
    if (!Array.isArray(cfg.args)) {
      errors.push('args must be an array.')
    } else if (cfg.args.some((a) => typeof a !== 'string')) {
      errors.push('args must be an array of strings.')
    }
  }
  if (cfg.env !== undefined) {
    if (typeof cfg.env !== 'object' || cfg.env === null || Array.isArray(cfg.env)) {
      errors.push('env must be an object.')
    } else if (Object.values(cfg.env).some((v) => typeof v !== 'string')) {
      errors.push('env values must be strings.')
    }
  }
  if (cfg.allowTerminal !== undefined && typeof cfg.allowTerminal !== 'boolean') {
    errors.push('allowTerminal must be a boolean.')
  }
  return { valid: errors.length === 0, errors }
}

/** True if an env value looks like a secret literal (not a $VAR placeholder). */
export function looksLikeSecretValue(value: string): boolean {
  const v = value.trim()
  if (v.length === 0) return false
  // A $VAR placeholder is safe to persist; anything else of nontrivial length
  // that isn't a placeholder is treated as a potential secret literal.
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return false
  return v.length >= 12
}

/** Load persisted agent configs (empty list when none stored). */
export async function loadAgentConfigs(): Promise<StoredAgentConfig[]> {
  const res = await persistenceApi.read<StoredAgentConfig[]>(ACP_AGENTS_KEY)
  if (res.success) {
    if (!Array.isArray(res.data)) return []
    // Filter out malformed records before the configId backfill so a corrupt
    // entry can never crash the load or the downstream merge
    // (`resolveSupportedAcpAgents` calls `.startsWith` on `config.id`).
    // Require the non-optional StoredAgentConfig primitives (id/name/command)
    // to be non-empty strings after trimming — a whitespace-only value is
    // meaningless and rejected. The map below trims the accepted identifiers
    // and normalizes optional/legacy fields (args/env/allowTerminal/configId)
    // to safe defaults instead of trusting persisted JSON shapes.
    const clean = res.data.filter(
      (c): c is StoredAgentConfig =>
        c !== null &&
        typeof c === 'object' &&
        typeof c.id === 'string' &&
        c.id.trim().length > 0 &&
        typeof c.name === 'string' &&
        c.name.trim().length > 0 &&
        typeof c.command === 'string' &&
        c.command.trim().length > 0
    )
    // Migration: backfill `configId = id` for persisted configs saved before
    // configId was required (pre-feature catalog overrides + custom agents
    // both need a non-empty configId on the spawn path). Validate the
    // configId type before trimming — a non-string value (e.g. `123`) must
    // not crash startup; treat it as missing and backfill from `id`. Trim
    // accepted identifiers. For args/env, validate EVERY element/value is a
    // string before retaining them; otherwise default to [] / {} rather than
    // casting invalid data (a non-string arg element or env value would
    // otherwise reach the Rust serde spawn path as a confusing type error).
    return clean.map((cfg) => {
      const id = cfg.id.trim()
      const name = cfg.name.trim()
      const command = cfg.command.trim()
      const configId =
        typeof cfg.configId === 'string' && cfg.configId.trim().length > 0
          ? cfg.configId.trim()
          : id
      const args =
        Array.isArray(cfg.args) && cfg.args.every((a) => typeof a === 'string') ? cfg.args : []
      const env =
        cfg.env !== null &&
        typeof cfg.env === 'object' &&
        !Array.isArray(cfg.env) &&
        Object.values(cfg.env).every((v) => typeof v === 'string')
          ? (cfg.env as Record<string, string>)
          : {}
      const icon = typeof cfg.icon === 'string' ? cfg.icon : undefined
      return {
        ...cfg,
        id,
        name,
        command,
        configId,
        args,
        env,
        icon,
        allowTerminal: typeof cfg.allowTerminal === 'boolean' ? cfg.allowTerminal : false
      }
    })
  }
  // A missing key is the normal empty state; any other failure is a real
  // storage/backend error and must not be silently collapsed to [].
  if (res.code === 'KEY_NOT_FOUND') return []
  throw new Error(res.error ?? 'Failed to load agent configs')
}

/** Persist the full agent-config list. */
export async function saveAgentConfigs(list: StoredAgentConfig[]): Promise<void> {
  // Defense-in-depth: secrets are sanitized at the dialog layer (raw values go
  // to OS secure storage, only `$PLACEHOLDER` is kept), but enforce the
  // "no raw secrets on disk" invariant here too so no future caller can bypass
  // it. Reject any env value that still looks like a raw secret literal.
  for (const cfg of list) {
    for (const [key, value] of Object.entries(cfg.env)) {
      if (looksLikeSecretValue(value)) {
        throw new Error(
          `refusing to persist a raw secret for env "${key}" on agent "${cfg.name}"; ` +
            `store it in secure storage and reference it as $${key}`
        )
      }
    }
  }
  const res = await persistenceApi.write(ACP_AGENTS_KEY, list)
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to persist agent configs')
  }
}
