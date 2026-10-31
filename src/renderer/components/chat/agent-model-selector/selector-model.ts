import type { PersistedModelCatalog } from '@shared/types/persistence.types'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { AgentCapabilities, SessionConfigOption, SessionModelState } from '@/lib/acp-api'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { flattenConfigOptionValues } from '../chat-input-bar-config'
import type { FavoriteKey } from './favorite-models'

/** Tabs shown in the agent track before the rest go behind "More". */
export const MAX_VISIBLE_AGENT_TABS = 4
/** Value of `view` that shows the overflow agent list instead of a model list. */
export const MORE_AGENTS_VIEW = '\0more'

/**
 * A model row's accessible name, set as the row button's `aria-label`:
 * `<name>[ · <agent>]`. One string, not sr-only fragments: Chrome reads an
 * absolutely positioned sr-only span as its own block and puts a space before
 * it ("Opus , thinking High"). The name is trimmed, as agents can send edge
 * whitespace. The Thinking level is on the row's Edit button, not here.
 */
export function rowAccessibleName({
  name,
  agentName
}: {
  name: string
  /** Another agent's model: whose it is. */
  agentName?: string
}): string {
  const label = name.trim()
  return agentName && agentInRowName(agentName) ? `${label} · ${agentName}` : label
}

/**
 * Whether `rowAccessibleName` names the agent: any other agent's model does.
 * Callers pass this to `rowTooltipDescription` instead of parsing the name.
 */
export function agentInRowName(agentName?: string): boolean {
  return Boolean(agentName)
}

/**
 * The row's visual tooltip: the full model name first (a long name truncates in
 * the row), then the agent, then the description. Never part of the accessible
 * name; the row keeps `rowAccessibleName`.
 */
export function rowTooltip({
  name,
  agentName,
  details
}: {
  name: string
  agentName?: string
  details?: string
}): string {
  return [name.trim(), agentName, details].filter(Boolean).join('\n\n')
}

/**
 * What the row tooltip adds for screen readers: everything the row's
 * `aria-label` does not already say. The name is always there; the agent is
 * too when `agentInName` (`agentInRowName`), so it is left out rather than
 * read twice. A blank string, not '', when there is nothing more, since Radix
 * falls back to the visible text for a falsy label.
 */
export function rowTooltipDescription({
  agentName,
  agentInName,
  details
}: {
  agentName?: string
  /** The row's accessible name already names the agent. */
  agentInName: boolean
  details?: string
}): string {
  return [agentInName ? undefined : agentName, details].filter(Boolean).join('\n\n') || ' '
}

/** Whether the row tooltip says anything the row's name does not (else no `aria-describedby`). */
export function rowHasDescription(description: string): boolean {
  return description.trim() !== ''
}

/**
 * The active row's Edit button name. With a Thinking level the button shows
 * that level, so the name carries it (WCAG 2.5.3, label in name):
 * `Edit <name>, thinking <level>`. Without one it says what it edits:
 * `Edit <sections> for <name>`.
 */
export function editButtonAccessibleName({
  name,
  thinking,
  sections,
  inFavorites = false
}: {
  name: string
  /** The current Thinking level, as the button shows it. */
  thinking?: string
  /** What the flyout sets, e.g. `Thinking and Context`. */
  sections: string
  /**
   * The button sits on the Favorites copy of the row, so its name says so and
   * differs from the list row's. The level stays last: the visible text is in the name.
   */
  inFavorites?: boolean
}): string {
  const model = name.trim()
  const where = inFavorites ? ' in Favorites' : ''
  return thinking
    ? `Edit ${model}${where}, thinking ${thinking}`
    : `Edit ${sections} for ${model}${where}`
}

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
 * Every agent as a tab, in catalog order, plus a stored-config tab for the
 * current, armed, or viewed agent when the catalog has not listed it yet.
 */
function allAgentTabs({
  currentConfigId,
  armedConfigId,
  viewConfigId,
  entries,
  agentConfigs
}: AgentTabSource): {
  all: AgentTab[]
  pinnedTab: (configId: string | null) => AgentTab | null
} {
  const all = entries.map((entry) => tabFromEntry(entry, agentConfigs))
  const byId = new Map(all.map((tab) => [tab.configId, tab]))
  const pinnedTab = (configId: string | null): AgentTab | null => {
    if (!configId) return null
    const found = byId.get(configId)
    if (found) return found
    const config = agentConfigs.find((c) => c.id === configId)
    return config ? { configId, name: config.name, config, entry: null } : null
  }
  const extra: AgentTab[] = []
  for (const id of [currentConfigId, armedConfigId, viewConfigId]) {
    const tab = pinnedTab(id)
    if (tab && !byId.has(tab.configId) && !extra.some((t) => t.configId === tab.configId)) {
      extra.push(tab)
    }
  }
  return { all: [...all, ...extra], pinnedTab }
}

interface AgentTabSource {
  currentConfigId: string | null
  armedConfigId: string | null
  viewConfigId: string | null
  entries: readonly SupportedAcpAgentEntry[]
  agentConfigs: readonly StoredAgentConfig[]
}

/**
 * Split agents into the visible tab track and the "More" list. The current
 * agent is always first, then the armed target, then other ready agents in
 * catalog order, up to `max` tabs. An agent opened from "More"
 * takes the last free slot so its tab shows as selected. (V1 panel.)
 */
export function buildAgentTabs({
  max = MAX_VISIBLE_AGENT_TABS,
  ...source
}: AgentTabSource & { max?: number }): { visible: AgentTab[]; overflow: AgentTab[] } {
  const { currentConfigId, armedConfigId, viewConfigId, entries, agentConfigs } = source
  const { pinnedTab } = allAgentTabs(source)
  const all = entries.map((entry) => tabFromEntry(entry, agentConfigs))
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

/**
 * Installed on this machine, from the registry's install status: `ready`
 * (not `install-required`, `needs-runtime`, `manual-install`, `unavailable`).
 * A tab with no registry entry is a stored custom agent, so it is installed.
 */
export function isInstalledTab(tab: AgentTab): boolean {
  return tab.entry ? tab.entry.status === 'ready' : tab.config != null
}

/**
 * The V2 agent order: installed agents, then the rest, each A to Z by name
 * (case- and accent-insensitive). It ignores which agent is current, armed, or
 * viewed, so choosing an agent never moves its tab.
 */
export function orderAgentTabs(tabs: readonly AgentTab[]): AgentTab[] {
  return tabs
    .map((tab, index) => ({ tab, index, installed: isInstalledTab(tab) }))
    .sort(
      (a, b) =>
        Number(b.installed) - Number(a.installed) ||
        a.tab.name.localeCompare(b.tab.name, undefined, { sensitivity: 'base' }) ||
        a.index - b.index
    )
    .map(({ tab }) => tab)
}

/**
 * Fill `capacity` slots with tabs. When they all fit there is no "More";
 * otherwise the last slot is "More" and holds the rest, in the same order.
 */
export function splitAgentTabs(
  ordered: readonly AgentTab[],
  capacity: number
): { visible: AgentTab[]; overflow: AgentTab[] } {
  const slots = Math.max(1, Math.floor(capacity))
  if (ordered.length <= slots) return { visible: [...ordered], overflow: [] }
  const shown = Math.max(0, slots - 1)
  return { visible: ordered.slice(0, shown), overflow: ordered.slice(shown) }
}

/** V2: every agent in `orderAgentTabs` order, split to fill `capacity` slots. */
export function stableAgentTabs(source: AgentTabSource & { capacity: number }): {
  visible: AgentTab[]
  overflow: AgentTab[]
} {
  return splitAgentTabs(orderAgentTabs(allAgentTabs(source).all), source.capacity)
}

/**
 * Slots in a track of `length` px whose tabs are `pitch` px apart, after
 * `padding` px of insets.
 */
export function tabTrackCapacity(length: number, pitch: number, padding = 0): number {
  return Math.max(1, Math.floor((length - padding) / pitch))
}

/**
 * The rail's Tailwind classes, the one source for its geometry: SelectorPanelV2
 * renders these and AGENT_TRACK derives its px from them.
 */
export const AGENT_TRACK_CLASS = {
  /** The list's height cap; the rail runs beside it. */
  listMaxHeight: 'max-h-72',
  /** The rail's top and bottom inset. */
  railPadding: 'py-1',
  /** Rail tabs are squares, as tall as a list row. */
  railTab: 'size-7',
  railTabTouch: 'size-11'
} as const

/** px of a class on Tailwind's default 4px spacing scale: `size-7` is 28. */
export function spacingPx(className: string): number {
  const step = Number(className.slice(className.lastIndexOf('-') + 1))
  if (!Number.isFinite(step)) throw new Error(`Not a spacing class: ${className}`)
  return step * 4
}

/** V2 track geometry, in px. */
export const AGENT_TRACK = {
  listMaxHeight: spacingPx(AGENT_TRACK_CLASS.listMaxHeight),
  /** `py-*` insets both ends. */
  railPadding: 2 * spacingPx(AGENT_TRACK_CLASS.railPadding),
  railPitch: spacingPx(AGENT_TRACK_CLASS.railTab),
  railPitchTouch: spacingPx(AGENT_TRACK_CLASS.railTabTouch),
  /** The desktop panel's `w-75`, less the strip's `px-1`. */
  stripWidth: 300,
  stripPadding: 8,
  stripPaddingTouch: 24,
  /** Narrowest top-strip tab: a 16px glyph with 10px either side; 44 on touch. */
  stripMinTab: 36,
  stripMinTabTouch: 44,
  /** Top strip on touch before its width is measured: the old 4 tabs + More. */
  stripFallbackSlots: 5
} as const

/**
 * Slots in the V2 agent track, "More" included. The rail runs the fixed list
 * height, so it is computed; the top strip on touch spans the sheet, so it
 * takes the measured panel width (null until measured).
 */
export function agentTrackCapacity({
  rail,
  touch,
  width
}: {
  rail: 'top' | 'left'
  touch: boolean
  width: number | null
}): number {
  const t = AGENT_TRACK
  if (rail === 'left') {
    return tabTrackCapacity(t.listMaxHeight, touch ? t.railPitchTouch : t.railPitch, t.railPadding)
  }
  if (!touch) return tabTrackCapacity(t.stripWidth, t.stripMinTab, t.stripPadding)
  return width
    ? tabTrackCapacity(width, t.stripMinTabTouch, t.stripPaddingTouch)
    : t.stripFallbackSlots
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

/** The favorite key for a model on an agent, or null when the agent cannot be armed. */
export function favoriteFor(
  entry: SupportedAcpAgentEntry,
  agentConfigs: readonly { id: string }[],
  modelId: string
): FavoriteKey | null {
  const configId = armableConfigId(entry, agentConfigs)
  return configId ? { configId, modelId } : null
}

/**
 * Favorites to show, in the given (starred) order, with the model each points
 * at. A favorite whose agent is not installed, has no known list, or no longer
 * offers the model is HIDDEN: the store keeps it, so a reinstall brings it back.
 */
export function resolveFavorites<F extends FavoriteKey>(
  favorites: readonly F[],
  catalogOf: (configId: string) => ModelCatalog | null,
  installed: (configId: string) => boolean = () => true
): Array<F & { model: CatalogModel }> {
  return favorites.flatMap((favorite) => {
    if (!installed(favorite.configId)) return []
    const model = catalogOf(favorite.configId)?.options.find((m) => m.value === favorite.modelId)
    return model ? [{ ...favorite, model }] : []
  })
}
