import { useMemo } from 'react'
import { armableConfigId } from '@/components/chat/agent-model-selector/selector-model'
import type { SelectorSource } from '@/components/chat/agent-model-selector/selector-source'
import type { SwitchModelPick } from '@/components/chat/agent-model-selector/use-agent-switch'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'

/**
 * The model selector's source in the launcher (no session yet). The current
 * agent is the launcher's selected agent; a tab or agent row selects an agent;
 * a model on another agent selects that agent with that model. The model-list
 * state (loading, setup error, sign-in) comes from the warm prepare, as the
 * old model chip showed it.
 */
export function useLauncherSelectorSource({
  paneKey,
  supportedAgents,
  agentConfigs,
  selectedEntry,
  installingConfigId,
  cwd,
  projectId,
  onSelectAgent,
  onSelectAgentWithModel,
  onInstall,
  showModelLoading,
  prepareError,
  hasCachedModels,
  canSignIn,
  onSignIn,
  onRetry,
  updateAgentIds
}: {
  paneKey: string
  supportedAgents: readonly SupportedAcpAgentEntry[]
  agentConfigs: readonly StoredAgentConfig[]
  selectedEntry: SupportedAcpAgentEntry | null
  installingConfigId: string | null
  cwd: string
  projectId: string
  onSelectAgent: (entry: SupportedAcpAgentEntry) => void
  onSelectAgentWithModel: (entry: SupportedAcpAgentEntry, pick: SwitchModelPick) => void
  onInstall: (entry: SupportedAcpAgentEntry) => void
  showModelLoading: boolean
  prepareError: PrepareChatError | null
  hasCachedModels: boolean
  canSignIn: boolean
  onSignIn: () => void
  onRetry: () => void
  updateAgentIds: ReadonlySet<string>
}): SelectorSource {
  return useMemo<SelectorSource>(() => {
    // Tabs key agents by the store id when one exists (see buildAgentTabs).
    const tabId = (entry: SupportedAcpAgentEntry): string =>
      armableConfigId(entry, agentConfigs) ?? entry.configId
    const entryFor = (configId: string): SupportedAcpAgentEntry | null =>
      supportedAgents.find((entry) => tabId(entry) === configId) ?? null
    const noop = (): void => {}
    return {
      kind: 'draft',
      key: `launcher-${paneKey}`,
      agentConfigs,
      entries: supportedAgents,
      currentConfigId: selectedEntry ? tabId(selectedEntry) : null,
      armedConfigId: null,
      blocked: false,
      turnBusy: false,
      installingConfigId,
      install: onInstall,
      workspace: { cwd, projectId },
      liveCatalog: null,
      pickCurrentModel: noop,
      pickOtherModel: (configId, pick) => {
        const entry = entryFor(configId)
        if (entry) onSelectAgentWithModel(entry, pick)
      },
      cancelThenSwitch: async () => {},
      selectAgent: (tab) => {
        const entry = tab.entry ?? entryFor(tab.configId)
        if (entry) onSelectAgent(entry)
      },
      modelStatus: {
        loading: showModelLoading,
        error: prepareError,
        stale: Boolean(prepareError && hasCachedModels),
        signInLabel: canSignIn ? 'Sign in' : null,
        onSignIn: canSignIn ? onSignIn : null,
        onRetry: prepareError ? onRetry : null
      },
      updateAgentIds
    }
  }, [
    paneKey,
    supportedAgents,
    agentConfigs,
    selectedEntry,
    installingConfigId,
    cwd,
    projectId,
    onSelectAgent,
    onSelectAgentWithModel,
    onInstall,
    showModelLoading,
    prepareError,
    hasCachedModels,
    canSignIn,
    onSignIn,
    onRetry,
    updateAgentIds
  ])
}
