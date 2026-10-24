import type { PersistedModelCatalog } from '@shared/types/persistence.types'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { AgentCapabilities, SessionConfigOption, SessionModelState } from '@/lib/acp-api'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { flattenConfigOptionValues } from '../chat-input-bar-config'

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

/**
 * What an agent advertised at `initialize`, one line per capability block,
 * for the tooltip on that agent's model rows. Text and stdio are the ACP
 * baseline every agent supports, so a line appears only when the agent sent
 * that block. Null when it sent neither.
 */
export function capabilitySummary(
  capabilities: AgentCapabilities | null | undefined
): string | null {
  const lines: string[] = []
  const prompt = capabilities?.promptCapabilities
  if (prompt) {
    const extras: string[] = []
    if (prompt.image) extras.push('Images')
    if (prompt.audio) extras.push('Audio (cannot attach yet)')
    if (prompt.embeddedContext) extras.push('Embedded context')
    lines.push(`Accepts: ${extras.length > 0 ? ['Text', ...extras].join(' · ') : 'Text only'}`)
  }
  const mcp = capabilities?.mcpCapabilities
  if (mcp) {
    const extras: string[] = []
    if (mcp.http) extras.push('HTTP')
    if (mcp.sse) extras.push('SSE')
    lines.push(
      `MCP servers: ${extras.length > 0 ? ['stdio', ...extras].join(' · ') : 'stdio only'}`
    )
  }
  return lines.length > 0 ? lines.join('\n') : null
}

export function catalogModels(option: SessionConfigOption): CatalogModel[] {
  return flattenConfigOptionValues(option).map(({ value, name, description }) => ({
    value,
    name,
    description: description ?? null
  }))
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

/**
 * Categories a context-window option arrives under. ACP reserves
 * `model_config` for "context size or speed"; agents that predate it send
 * `other`. A missing category is allowed too: ACP makes categories optional.
 */
const CONTEXT_OPTION_CATEGORIES: ReadonlySet<string> = new Set(['model_config', 'other'])
/** `context`, `context_window`, `contextWindow`, `context-size`, … */
const CONTEXT_OPTION_ID = /^context(?:[_-]?(?:window|size))?$/i

/**
 * Whether an agent config option picks the context window (Cursor's
 * `context`: 300K | 1M, or 256K | 500K on some models). Matches the option
 * id and category only, never a value label: the values change per model and
 * the view renders whatever the agent sends.
 */
export function isContextOption(option: SessionConfigOption): boolean {
  if (option.type !== 'select') return false
  if (option.category != null && !CONTEXT_OPTION_CATEGORIES.has(option.category)) return false
  if (!CONTEXT_OPTION_ID.test(option.id)) return false
  return flattenConfigOptionValues(option).length > 0
}

/** The first context-window option, and the options left over. */
export function splitContextOption(options: readonly SessionConfigOption[]): {
  context: SessionConfigOption | null
  rest: SessionConfigOption[]
} {
  const index = options.findIndex(isContextOption)
  if (index < 0) return { context: null, rest: [...options] }
  return { context: options[index], rest: options.filter((_, i) => i !== index) }
}

/**
 * A starred model. `configId` is the STORE id that `armableConfigId` returns,
 * never the registry agent id: picking a favorite arms that config.
 */
export interface FavoriteModel {
  configId: string
  value: string
}

/** The favorite for a model on an agent, or null when the agent cannot be armed. */
export function favoriteFor(
  entry: SupportedAcpAgentEntry,
  agentConfigs: readonly { id: string }[],
  value: string
): FavoriteModel | null {
  const configId = armableConfigId(entry, agentConfigs)
  return configId ? { configId, value } : null
}

/**
 * Favorites that still exist, in starred order, with the model each points
 * at. A favorite whose agent has no known list, or whose model is gone, drops.
 */
export function resolveFavorites(
  favorites: readonly FavoriteModel[],
  catalogOf: (configId: string) => ModelCatalog | null
): Array<FavoriteModel & { model: CatalogModel }> {
  return favorites.flatMap((favorite) => {
    const model = catalogOf(favorite.configId)?.options.find((m) => m.value === favorite.value)
    return model ? [{ ...favorite, model }] : []
  })
}
