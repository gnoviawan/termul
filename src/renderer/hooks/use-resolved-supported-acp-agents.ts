import { useEffect, useState } from 'react'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  resolveSupportedAcpAgents,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'

/**
 * Resolve supported ACP agents from the host-resolved catalog (CAP-6 / Story 8).
 *
 * The host is the single source of truth for OS, arch, runtime availability,
 * and per-agent installability status — the renderer never probes
 * `@tauri-apps/plugin-os` or PATH locally. Returns an empty list until the
 * first catalog resolution completes so callers can render an empty/loading
 * state without flashing the desktop-only `currentPlatformArch()` derivation.
 * Re-resolves when `persistedConfigs` changes (e.g. the user saves a new agent
 * config so it is projected as `ready`).
 */
export function useResolvedSupportedAcpAgents(
  persistedConfigs: readonly StoredAgentConfig[]
): readonly SupportedAcpAgentEntry[] {
  const [entries, setEntries] = useState<readonly SupportedAcpAgentEntry[]>([])

  useEffect(() => {
    let cancelled = false
    void resolveSupportedAcpAgents(persistedConfigs)
      .then((resolved) => {
        if (!cancelled) setEntries(resolved)
      })
      .catch(() => {
        // A rejected catalog resolution must not leave the hook stuck or
        // surface an unhandled rejection. Treat failure as "no agents"
        // (callers fall back to default-agent selection which handles empty).
        if (!cancelled) setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [persistedConfigs])

  return entries
}
