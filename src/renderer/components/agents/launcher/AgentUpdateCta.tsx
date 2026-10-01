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
  const registryUpdateAgent = useMemo(() => {
    if (!selectedEntry) return null
    const update = agentUpdates.find((u) => u.configId === selectedEntry.configId)
    if (!update) return null
    return targetRegistry.find((a) => a.id === update.agentId) ?? null
  }, [agentUpdates, selectedEntry, targetRegistry])
  const [inFlightUpdate, setInFlightUpdate] = useState<{
    configId: string
    agent: RegistryAgent
  } | null>(null)
  const updatingAgent =
    selectedEntry && inFlightUpdate?.configId === selectedEntry.configId
      ? inFlightUpdate.agent
      : null
  // Preserve the target/version while the async host install is running. The
  // persisted config can update before the registry-backed entry refreshes,
  // temporarily making `registryUpdateAgent` null.
  const selectedUpdateAgent = updatingAgent ?? registryUpdateAgent

  const handleUpdate = (): void => {
    if (!selectedEntry || !registryUpdateAgent || inFlightUpdate) return
    const configId = selectedEntry.configId
    const agent = registryUpdateAgent
    setInFlightUpdate({ configId, agent })
    void (async () => {
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
        await applyAgentUpdate(configId, agent)
        toast.success(
          `${agent.name} ${agent.version} is ready. Select Restart to open a new chat; existing chats keep running.`
        )
      } catch (err) {
        toast.error(String(err))
        void logFrontendError({
          level: 'error',
          source: 'agentLauncher.updateSelectedAgent',
          message: `Update failed for ${agent.id}: ${err instanceof Error ? err.message : String(err)}`
        })
      } finally {
        setInFlightUpdate((current) => (current?.configId === configId ? null : current))
      }
    })()
  }

  return { selectedUpdateAgent, updating: updatingAgent !== null, handleUpdate }
}

/**
 * Single-agent update lifecycle CTA: Update → Updating → Restart.
 */
export function AgentUpdateCta({
  agentName,
  version,
  updating,
  restarting,
  restartAvailable,
  onUpdate,
  onRestart
}: {
  agentName: string
  version: string
  updating: boolean
  restarting: boolean
  restartAvailable: boolean
  onUpdate: () => void
  onRestart: () => void
}): React.JSX.Element {
  const status = updating
    ? 'updating'
    : restarting
      ? 'restarting'
      : restartAvailable
        ? 'ready'
        : 'update'
  const isBusy = status === 'updating' || status === 'restarting'
  const accessibleAction =
    status === 'updating'
      ? `Updating ${agentName} to version ${version}`
      : status === 'restarting'
        ? `Restarting ${agentName} with version ${version}`
        : status === 'ready'
          ? `Restart ${agentName} with version ${version}`
          : `Update ${agentName} to version ${version}`

  return (
    <button
      type="button"
      onClick={status === 'ready' ? onRestart : onUpdate}
      disabled={isBusy}
      title={
        status === 'ready'
          ? `Open a new ${agentName} chat on ${version}. Existing chats keep running their current version.`
          : undefined
      }
      aria-label={accessibleAction}
      data-testid="agent-update-cta"
      className="inline-flex items-center gap-1.5 rounded-full bg-connection/15 px-2.5 py-1 text-2xs font-medium text-connection hover:bg-connection/25 disabled:cursor-progress disabled:opacity-70"
    >
      {isBusy ? <RefreshCw size={11} className="animate-spin" /> : null}
      {status === 'updating'
        ? 'Updating…'
        : status === 'restarting'
          ? 'Restarting…'
          : status === 'ready'
            ? 'Restart'
            : `Update to ${version}`}
    </button>
  )
}
