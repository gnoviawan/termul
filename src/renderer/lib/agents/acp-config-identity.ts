/**
 * Canonical identity fingerprint of an agent config's launch-defining fields:
 * cmd / args / env / allowTerminal (path and install identity are reflected in
 * `command` + `args`). Env keys are sorted so insertion-order differences do
 * not spuriously invalidate.
 *
 * Single owner of the env normalization for BOTH consumers — options-cache
 * invalidation (`acp-store.ts`) and catalog-migration reconciliation
 * (`needsPersistedConfigUpdate` in `supported-acp-agents.ts`) — which
 * previously duplicated the comparator with different env key sorts.
 */
export function agentConfigIdentityKey(config: {
  command: string
  args: readonly string[]
  env: Record<string, string>
  allowTerminal?: boolean
}): string {
  const envKeys = Object.keys(config.env).sort()
  const env: Record<string, string> = {}
  for (const key of envKeys) {
    env[key] = config.env[key]
  }
  return JSON.stringify({
    command: config.command,
    args: config.args,
    env,
    allowTerminal: Boolean(config.allowTerminal)
  })
}

/**
 * Stable fingerprint of just an env map (sorted keys, JSON form). Used by
 * `needsPersistedConfigUpdate`, which compares launch-defining fields only
 * (no `allowTerminal`) when reconciling catalog migrations.
 */
export function agentEnvIdentity(env: Record<string, string>): string {
  const envKeys = Object.keys(env).sort()
  const stable: Record<string, string> = {}
  for (const key of envKeys) {
    stable[key] = env[key]
  }
  return JSON.stringify(stable)
}
