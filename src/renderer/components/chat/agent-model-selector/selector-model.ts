import type { PersistedModelCatalog } from '@shared/types/persistence.types'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { SessionConfigOption, SessionModelState } from '@/lib/acp-api'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'

/** Tabs shown in the agent track before the rest go behind "More". */
export const MAX_VISIBLE_AGENT_TABS = 4
/** Value of `view` that shows the overflow agent list instead of a model list. */
export const MORE_AGENTS_VIEW = '\0more'

export interface CatalogModel {
  value: string
  name: string
  description?: string | null
}

/**
 * One agent's model list, from whichever surface the agent gives: its
 * `category: 'model'` config option (`source: 'config'`) or the native ACP
 * model state (`source: 'models'`).
 */
export interface ModelCatalog {
  /** The model config option id (`'model'` for the native model state). */
  id: string
  source: 'config' | 'models'
  options: CatalogModel[]
  currentValue: string | null
}

/** Catalog entries of a config option: only the ones with a string value
 * (boolean options carry none; groups are not model rows). */
export function catalogModels(option: SessionConfigOption): CatalogModel[] {
  return (option.options ?? []).flatMap((entry) =>
    typeof entry.value === 'string'
      ? [{ value: entry.value, name: entry.name, description: entry.description ?? null }]
      : []
  )
}

export function catalogFromSessionState(
  models: SessionModelState | null | undefined,
  configOptions: readonly SessionConfigOption[] | null | undefined
): ModelCatalog | null {
  const option = configOptions?.find(
    (o) =>
      o.category === 'model' && typeof o.currentValue === 'string' && (o.options?.length ?? 0) > 0
  )
  if (option) {
    return {
      id: option.id,
      source: 'config',
      options: catalogModels(option),
      currentValue: typeof option.currentValue === 'string' ? option.currentValue : null
    }
  }
  if (models && models.availableModels.length > 0) {
    return {
      id: 'model',
      source: 'models',
      options: models.availableModels.map((m) => ({
        value: m.modelId,
        name: m.name,
        description: m.description ?? null
      })),
      currentValue: models.currentModelId
    }
  }
  return null
}

export function catalogFromPersisted(
  saved: PersistedModelCatalog | null | undefined
): ModelCatalog | null {
  if (!saved) return null
  return catalogFromSessionState(
    saved.models,
    saved.modelOption ? [{ ...saved.modelOption, category: 'model', type: 'select' }] : []
  )
}

/**
 * The id `armAgentSwitch` accepts: the STORE's `agentConfigs` id. A resolved
 * entry's `configId` can diverge for imported custom agents (the resolver
 * prefers `config.configId ?? config.id` when merging), so ready entries arm
 * by the stored id whenever the entry carries a config; catalog-only ids keep
 * their registry configId (an install/save lands them in `agentConfigs`).
 * Null when the entry cannot be armed at all (unknown config).
 */
export function armableConfigId(
  entry: SupportedAcpAgentEntry,
  agentConfigs: readonly { id: string }[]
): string | null {
  const candidate = entry.config?.id ?? entry.configId
  return agentConfigs.some((c) => c.id === candidate) ? candidate : null
}

/** Why an agent cannot be used from the selector, or null when it can. */
export function entryDisableReason(entry: SupportedAcpAgentEntry): string | null {
  if (entry.status === 'manual-install') {
    return entry.unavailableReason ?? 'Manual install required'
  }
  if (entry.status === 'unavailable') {
    return entry.unavailableReason ?? 'Not available on this platform'
  }
  if (entry.status === 'needs-runtime') {
    return entry.unavailableReason ?? 'Runtime missing'
  }
  return null
}

export interface AgentTab {
  /** The id the selector arms and keys model lists by. */
  configId: string
  name: string
  config: StoredAgentConfig | null
  entry: SupportedAcpAgentEntry | null
}

function tabFromEntry(
  entry: SupportedAcpAgentEntry,
  agentConfigs: readonly StoredAgentConfig[]
): AgentTab {
  const configId = armableConfigId(entry, agentConfigs) ?? entry.configId
  return {
    configId,
    name: entry.config?.name ?? entry.agent.name,
    config: entry.config ?? agentConfigs.find((c) => c.id === configId) ?? null,
    entry
  }
}

/**
 * Split agents into the visible tab track and the "More" list. The current
 * agent is always first, then the armed target, then other ready agents in
 * catalog order, up to `max` tabs. An agent opened from "More"
 * takes the last free slot so its tab shows as selected.
 */
export function buildAgentTabs({
  currentConfigId,
  armedConfigId,
  viewConfigId,
  entries,
  agentConfigs,
  max = MAX_VISIBLE_AGENT_TABS
}: {
  max?: number
  currentConfigId: string | null
  armedConfigId: string | null
  viewConfigId: string | null
  entries: readonly SupportedAcpAgentEntry[]
  agentConfigs: readonly StoredAgentConfig[]
}): { visible: AgentTab[]; overflow: AgentTab[] } {
  const all = entries.map((entry) => tabFromEntry(entry, agentConfigs))
  const byId = new Map(all.map((tab) => [tab.configId, tab]))
  const pinnedTab = (configId: string | null): AgentTab | null => {
    if (!configId) return null
    const found = byId.get(configId)
    if (found) return found
    const config = agentConfigs.find((c) => c.id === configId)
    return config ? { configId, name: config.name, config, entry: null } : null
  }
  const visible: AgentTab[] = []
  const push = (tab: AgentTab | null): void => {
    if (tab && !visible.some((t) => t.configId === tab.configId)) visible.push(tab)
  }
  push(pinnedTab(currentConfigId))
  push(pinnedTab(armedConfigId))
  for (const tab of all) {
    if (visible.length >= max) break
    if (tab.entry?.status === 'ready' && armableConfigId(tab.entry, agentConfigs)) push(tab)
  }
  const viewTab = pinnedTab(viewConfigId)
  if (viewTab && !visible.some((t) => t.configId === viewTab.configId)) {
    const pinned = new Set([currentConfigId, armedConfigId])
    if (visible.length >= max) {
      for (let i = visible.length - 1; i >= 0; i--) {
        if (pinned.has(visible[i].configId)) continue
        visible.splice(i, 1)
        break
      }
    }
    push(viewTab)
  }
  const shown = new Set(visible.map((t) => t.configId))
  return { visible, overflow: all.filter((tab) => !shown.has(tab.configId)) }
}

/** Case-insensitive match on a model's name, id, and description. */
export function modelMatches(model: CatalogModel, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [model.name, model.value, model.description ?? ''].join(' ').toLowerCase().includes(q)
}
