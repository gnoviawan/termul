import type { LastSelectedAgent } from '@shared/types/persistence.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { useEffect } from 'react'
import {
  pickDefaultConfiguredAgent,
  pickDefaultSupportedAgent,
  resolveSupportedAcpAgents
} from '@/lib/agents/supported-acp-agents'
import { persistenceApi } from '@/lib/api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

/**
 * Load persisted ACP agent configs once at app mount, then resolve the
 * last-selected ready supported ACP agent (falling back to the default ready
 * entry) and select it as the chat default and prewarm it. The hook warms that agent's
 * PROCESS only (story 8: boot never creates a session — the warm session is
 * seeded lazily on the first real user action, i.e. the launcher opening and
 * calling `retargetWarmPool`/`prepareChat`, so boot persists nothing and no
 * untitled junk session is written). Re-runs on project switch. Agent Chat
 * derives supported configs automatically, so prewarm must not fan out across
 * every supported agent or depend on Preferences toggles.
 *
 * Platform split (issue #840): desktop prewarms the selected process on load
 * as before; web selects only among CONFIGURED agents and never prewarms on
 * page load — the launcher's `retargetWarmPool` on composer open (which only
 * proceeds for a persisted config) is the first web prewarm.
 */
export function useAcpAgents(): void {
  const loadAgentConfigs = useAcpStore((s) => s.loadAgentConfigs)
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const setSelectedAgentConfigId = useAcpStore((s) => s.setSelectedAgentConfigId)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await loadAgentConfigs()
      if (cancelled) return
      const { agentConfigs, prewarmAgent } = useAcpStore.getState()
      const cwd = activeProjectId ? getDefaultCwdForProject(activeProjectId) : ''
      if (cwd.trim().length === 0) {
        setSelectedAgentConfigId(null)
        return
      }
      const supportedAgents = await resolveSupportedAcpAgents(agentConfigs)
      const persisted = await persistenceApi.read<unknown>(PersistenceKeys.lastSelectedAgent)
      if (cancelled) return
      const saved = persisted.success ? (persisted.data as Partial<LastSelectedAgent> | null) : null
      const desktop = isTauriContext()
      // Issue #840: on web a persisted selection is honored only when the
      // agent is actually configured — a stale/foreign id must not resurrect
      // an unconfigured catalog entry (e.g. a codex `npx` launcher) as the
      // preselected default.
      // Issue #840 (narrowed by #907): on web a persisted selection is
      // honored when the agent is CONFIGURED, or when it is a `ready` entry
      // with a derivable `config` (host-installed binary catalog agent, e.g.
      // OpenCode) — a reload must keep the agent the user last selected, not
      // fall through to a different configured default. A ready npx-derived
      // entry therefore also restores its SELECTION — but selection-only:
      // web boot still never persists or prewarms, so the #840 no-auto-spawn
      // invariant holds (the spawn harm #840 guarded against).
      const selected =
        saved?.mode === 'acp' && typeof saved.agentId === 'string'
          ? supportedAgents.find(
              (entry) =>
                entry.configId === saved.agentId &&
                entry.status === 'ready' &&
                (desktop ||
                  Boolean(entry.config) ||
                  agentConfigs.some((config) => config.id === entry.config?.id))
            )
          : null
      // Issue #840: on web the default is restricted to CONFIGURED agents —
      // the catalog-derived preferred default (Codex via `npx`) must not be
      // auto-selected (and auto-persisted) on every page load, because that
      // spawned a ~310 MB `npm exec` tree before the user picked anything.
      const entry =
        selected ??
        (desktop
          ? pickDefaultSupportedAgent(supportedAgents)
          : pickDefaultConfiguredAgent(
              supportedAgents,
              new Set(agentConfigs.map((config) => config.id))
            ))
      if (!entry?.config) {
        setSelectedAgentConfigId(null)
        return
      }
      // Issue #907: on web an unconfigured-but-restorable entry (ready with
      // a derivable config) is SELECTED only — boot must never persist a
      // catalog-derived config or spawn a process the user did not pick
      // (#840). The launcher's prewarm effect handles persistence after an
      // explicit user pick. Desktop keeps the eager persist.
      const entryConfigured = agentConfigs.some((config) => config.id === entry.config?.id)
      if (!entryConfigured) {
        if (!desktop) {
          setSelectedAgentConfigId(entry.config.id)
          return
        }
        await saveAgentConfig(entry.config)
        if (cancelled) return
      }
      // `activeProjectId` is a dep, so a project switch re-runs this effect
      // and flips `cancelled` on the previous (in-flight) run via its cleanup.
      // Guard every await boundary so only the latest run reaches prewarmAgent.
      if (cancelled) return
      setSelectedAgentConfigId(entry.config.id)
      // Story 8: process-only warm. No `retargetWarmPool`/`prepareChat` here —
      // boot must not fire `create_session` (an unpromoted warm session is
      // backend-ephemeral and never persisted).
      // Issue #840: web never prewarms on page load. The launcher's
      // `retargetWarmPool` (composer open, configured agent only) is the
      // first — and only — web prewarm path.
      if (desktop) void prewarmAgent(entry.config.id, cwd)
    })()
    return () => {
      cancelled = true
    }
  }, [loadAgentConfigs, saveAgentConfig, setSelectedAgentConfigId, activeProjectId])
}
