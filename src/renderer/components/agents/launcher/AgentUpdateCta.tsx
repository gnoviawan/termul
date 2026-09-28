import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw } from '@/components/icons'
import type { RegistryAgent } from '@/lib/agents/acp-registry'
import type { AgentUpdate } from '@/lib/agents/agent-update-utils'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { logFrontendError } from '@/lib/log-api'

/** The registry-catalog inputs the single-update CTA needs from the launcher. */
export interface SelectedAgentUpdateRegistry {
  /** Whether the remote registry is already applied (ADR-0001 opt-in). */
  usingRemoteRegistry: boolean
  /** The registry to resolve drift against (applied when opted in, else advisory). */
  targetRegistry: readonly RegistryAgent[]
  /** Absorbs the registry opt-in into the update click. */
  applyRemoteRegistry: () => Promise<unknown>
  /** Rewrites the agent's launch spec to the target registry version. */
  applyAgentUpdate: (configId: string, agent: RegistryAgent) => Promise<unknown>
}

export interface SelectedAgentUpdate {
  /** The registry agent behind the selected entry's drift, when one exists. */
  selectedUpdateAgent: RegistryAgent | null
  /** True while the host install for the selected agent is in flight. */
  updating: boolean
  handleUpdate: () => void
}

/**
 * Single-update CTA state for the CURRENTLY SELECTED agent (no batch): the
 * registry agent behind the selected entry's drift, when one exists, plus the
 * update action. One click absorbs the registry opt-in — the click IS the
 * explicit consent ADR-0001 requires — then rewrites this agent's launch spec.
 */
export function useSelectedAgentUpdate(
  selectedEntry: SupportedAcpAgentEntry | null,
  agentUpdates: readonly AgentUpdate[],
  registry: SelectedAgentUpdateRegistry
): SelectedAgentUpdate {
  const { usingRemoteRegistry, targetRegistry, applyRemoteRegistry, applyAgentUpdate } = registry
  const selectedUpdateAgent = useMemo(() => {
    if (!selectedEntry) return null
    const update = agentUpdates.find((u) => u.configId === selectedEntry.configId)
    if (!update) return null
    return targetRegistry.find((a) => a.id === update.agentId) ?? null
  }, [agentUpdates, selectedEntry, targetRegistry])
  const [updating, setUpdating] = useState(false)

  const handleUpdate = (): void => {
    if (!selectedEntry || !selectedUpdateAgent) return
    void (async () => {
      setUpdating(true)
      try {
        // One click absorbs the registry opt-in — the click IS the explicit
        // consent ADR-0001 requires — then rewrites this agent's launch spec.
        if (!usingRemoteRegistry) {
          try {
            await applyRemoteRegistry()
          } catch (err) {
            toast.error(String(err))
            return
          }
        }
        await applyAgentUpdate(selectedEntry.configId, selectedUpdateAgent)
        toast.success(
          `${selectedUpdateAgent.name} updated to ${selectedUpdateAgent.version} — your next chat with this agent uses the new version.`
        )
      } catch (err) {
        toast.error(String(err))
        void logFrontendError({
          level: 'error',
          source: 'agentLauncher.updateSelectedAgent',
          message: `Update failed for ${selectedUpdateAgent.id}: ${err instanceof Error ? err.message : String(err)}`
        })
      } finally {
        setUpdating(false)
      }
    })()
  }

  return { selectedUpdateAgent, updating, handleUpdate }
}

/**
 * Single-update CTA: only the agent the user is about to use. Action
 * language, spinner while the host install runs.
 */
export function AgentUpdateCta({
  agentName,
  version,
  updating,
  onUpdate
}: {
  agentName: string
  version: string
  updating: boolean
  onUpdate: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onUpdate}
      disabled={updating}
      aria-label={`Update ${agentName} to version ${version}`}
      data-testid="agent-update-cta"
      className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/15 px-2.5 py-1 text-2xs font-medium text-sky-600 hover:bg-sky-500/25 disabled:cursor-progress disabled:opacity-70 dark:text-sky-400"
    >
      {updating ? <RefreshCw size={11} className="animate-spin" /> : null}
      {updating ? 'Updating…' : `Update to ${version}`}
    </button>
  )
}
