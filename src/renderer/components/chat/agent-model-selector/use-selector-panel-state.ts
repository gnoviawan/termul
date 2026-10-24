import { useEffect, useMemo, useState } from 'react'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { shouldShowSessionUsage } from '../context-usage-utils'
import type { FavoriteModel } from './favorite-models'
import type { SelectorPanelProps } from './SelectorPanel'
import {
  type AgentTab,
  armableConfigId,
  buildAgentTabs,
  type CatalogModel,
  capabilitySummary,
  catalogModels,
  isInstalledTab,
  MORE_AGENTS_VIEW,
  type ModelCatalog,
  modelMatches,
  resolveFavorites,
  stableAgentTabs
} from './selector-model'
import type { SelectorModelStatus } from './selector-source'
import type { SwitchModelPick } from './use-agent-switch'
import { loadPersistedCatalog, useKnownCatalogs, useOtherAgentCatalog } from './use-model-catalog'

const NO_IDS: readonly string[] = []
const NO_FAVORITES: readonly FavoriteModel[] = []

export interface ModelHit {
  configId: string
  catalog: ModelCatalog | null
  model: CatalogModel
}

/** What the panel's list shows. Each kind is one body; the panels draw them. */
export type PanelView =
  | { kind: 'search'; own: CatalogModel[]; others: ModelHit[]; agents: AgentTab[]; count: number }
  | { kind: 'more'; tabs: AgentTab[] }
  | {
      kind: 'install'
      tab: AgentTab
      entry: SupportedAcpAgentEntry
      installing: boolean
      installBlocked: boolean
      install: (() => void) | null
    }
  | {
      /** The composer's agent; `catalog` is null when it gives no model choice. */
      kind: 'effective'
      catalog: ModelCatalog | null
      favorites: ModelHit[]
      /** The list is from the last session; this is why. */
      stale: SelectorModelStatus | null
    }
  | { kind: 'current'; catalog: ModelCatalog | null }
  | { kind: 'other'; catalog: ModelCatalog; confirming: boolean }
  | {
      kind: 'error'
      title: string
      detail: string | undefined
      /** The composer agent's status, with its sign-in and retry actions. */
      status: SelectorModelStatus | null
      retry: (() => void) | null
    }
  | { kind: 'loading'; title: string }

export interface SelectorPanelState {
  query: string
  /** Typing also drops a pending busy confirmation. */
  setQuery: (query: string) => void
  searching: boolean
  showingMore: boolean
  effectiveId: string | null
  viewId: string | null
  viewTab: AgentTab | null
  tabs: { visible: AgentTab[]; overflow: AgentTab[] }
  /** The viewed agent sits behind "More" (V2's stable order keeps it there). */
  viewInOverflow: boolean
  view: PanelView
  /** Changes when the list's content identity changes; keys its crossfade. */
  listKey: string
  /** The effective agent's model list as a catalog, for picks. */
  effectiveCatalog: ModelCatalog | null
  capabilities: string | null
  /** True when the footer controls belong to what the list shows. */
  ownFooter: boolean
  /** Another agent's tab with models: the footer says how to reach its options. */
  otherHintTab: AgentTab | null
  contextUsage: ReturnType<typeof shouldShowSessionUsage>
  pick: (configId: string | null, catalog: ModelCatalog | null, value: string) => void
  openAgent: (tab: AgentTab) => void
  showMore: () => void
  /** The busy confirmation's two answers. */
  waitForTurn: () => void
  cancelAndSwitch: () => void
  tabOf: (configId: string | null) => AgentTab | null
  nameOf: (configId: string | null) => string
  badgeOf: (tab: AgentTab) => string | null
  notSetUp: (tab: AgentTab) => boolean
  hasUpdate: (tab: AgentTab) => boolean
}

function statusBadge(
  entry: SupportedAcpAgentEntry | null,
  installing: boolean,
  armable: boolean
): string | null {
  if (!entry) return null
  if (entry.status === 'ready' && !armable) return 'Not set up'
  if (entry.status === 'install-required') return installing ? 'Installing…' : 'Install'
  if (entry.status === 'needs-runtime') {
    return entry.runtimeLauncher === 'uvx' ? 'Needs uv' : 'Needs Node'
  }
  if (entry.status === 'manual-install') return 'Manual install'
  if (entry.status === 'unavailable') return 'Unavailable'
  return null
}

/**
 * The selector's state machine, shared by both panel layouts: the search,
 * the viewed agent, the busy confirmation, picks, and which body the list
 * shows. A tab shows that agent's models in place. Choosing another agent's
 * model arms the switch with that model; the next send runs it. Search covers
 * the models of every agent with a known list.
 */
export function useSelectorPanelState(
  props: SelectorPanelProps,
  options: {
    /** Keep a grid column for "More" by showing one tab fewer when agents overflow. */
    reserveMoreTab: boolean
    /**
     * V2: tabs keep one order (installed first, then A to Z; `orderAgentTabs`)
     * and fill this many slots, the last one "More" when they overflow. Unset
     * (V1): the current agent first, the armed one next, the viewed one pinned.
     */
    stableTabCapacity?: number
    favorites?: readonly FavoriteModel[]
  }
): SelectorPanelState {
  const { source: sw, modelOption, onClose, escapeRef } = props
  const favorites = options.favorites ?? NO_FAVORITES
  const [query, setQueryState] = useState('')
  const [view, setView] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ configId: string; pick: SwitchModelPick } | null>(null)

  const effectiveId = sw.armedConfigId ?? sw.currentConfigId
  const showingMore = view === MORE_AGENTS_VIEW
  const viewId = showingMore ? null : (view ?? effectiveId)
  const searching = query.trim().length > 0

  const { reserveMoreTab, stableTabCapacity } = options
  const tabs = useMemo(() => {
    const args = {
      currentConfigId: sw.currentConfigId,
      armedConfigId: sw.armedConfigId,
      viewConfigId: viewId,
      entries: sw.entries,
      agentConfigs: sw.agentConfigs
    }
    if (stableTabCapacity != null) return stableAgentTabs({ ...args, capacity: stableTabCapacity })
    const first = buildAgentTabs(args)
    return reserveMoreTab && first.overflow.length > 0 ? buildAgentTabs({ ...args, max: 3 }) : first
  }, [
    sw.currentConfigId,
    sw.armedConfigId,
    viewId,
    sw.entries,
    sw.agentConfigs,
    reserveMoreTab,
    stableTabCapacity
  ])
  const viewInOverflow = viewId != null && tabs.overflow.some((t) => t.configId === viewId)
  const allTabs = useMemo(() => [...tabs.visible, ...tabs.overflow], [tabs])
  const tabById = useMemo(() => new Map(allTabs.map((t) => [t.configId, t])), [allTabs])
  const tabOf = (configId: string | null): AgentTab | null =>
    configId ? (tabById.get(configId) ?? null) : null
  // Chat cannot arm a ready agent that has no stored config (the store
  // rejects the arm). The launcher can: an explicit pick persists that config
  // and prewarms it (issue #907). Do not disable those rows in the launcher.
  const notSetUp = (tab: AgentTab): boolean =>
    sw.selectAgent == null &&
    tab.entry?.status === 'ready' &&
    armableConfigId(tab.entry, sw.agentConfigs) === null
  const hasUpdate = (tab: AgentTab): boolean =>
    Boolean(tab.entry && sw.updateAgentIds?.has(tab.entry.agent.id))
  const badgeOf = (tab: AgentTab): string | null =>
    statusBadge(tab.entry, sw.installingConfigId === tab.configId, !notSetUp(tab)) ??
    (hasUpdate(tab) ? 'Update' : null)
  const viewTab = tabOf(viewId)
  const nameOf = (configId: string | null): string => tabOf(configId)?.name || 'this agent'

  const tabIdsKey = allTabs.map((t) => t.configId).join('\n')
  useEffect(() => {
    for (const configId of tabIdsKey.split('\n')) if (configId) loadPersistedCatalog(configId)
  }, [tabIdsKey])

  const viewKind: 'effective' | 'current' | 'other' =
    viewId === effectiveId ? 'effective' : viewId === sw.currentConfigId ? 'current' : 'other'
  const viewEntry = viewTab?.entry ?? null
  const viewReady = viewEntry ? viewEntry.status === 'ready' : Boolean(viewTab?.config)
  const other = useOtherAgentCatalog(
    sw.workspace,
    !searching && viewKind === 'other' && viewReady ? viewId : null,
    true
  )

  // Other agents' known lists: every tab while searching, starred agents on
  // the effective view.
  const showFavorites = !searching && viewKind === 'effective' && favorites.length > 0
  const favoriteIdsKey = favorites.map((f) => f.configId).join('\n')
  const lookupIds = useMemo(() => {
    const ids = new Set<string>()
    if (searching) {
      for (const t of allTabs) if (t.configId !== effectiveId) ids.add(t.configId)
    }
    if (showFavorites) {
      for (const id of favoriteIdsKey.split('\n')) {
        const tab = tabById.get(id)
        if (id && id !== effectiveId && tab && isInstalledTab(tab)) ids.add(id)
      }
    }
    return ids.size > 0 ? [...ids] : NO_IDS
  }, [searching, showFavorites, allTabs, tabById, effectiveId, favoriteIdsKey])
  const known = useKnownCatalogs(sw.workspace.cwd, lookupIds)
  const knownById = new Map(lookupIds.map((id, i) => [id, known[i] ?? null]))

  const setQuery = (next: string): void => {
    setQueryState(next)
    setConfirm(null)
  }

  escapeRef.current = () => {
    if (confirm) {
      setConfirm(null)
      return true
    }
    if (query) {
      setQueryState('')
      return true
    }
    return false
  }

  // A model pick never closes the panel: effort levels and Fast depend on the
  // model (the agent sends new ones), so the user sets them next, here.
  const pick = (configId: string | null, catalog: ModelCatalog | null, value: string): void => {
    if (configId === effectiveId) {
      props.onPickModel(value)
      return
    }
    if (configId && configId === sw.currentConfigId) {
      sw.pickCurrentModel(catalog, value)
      return
    }
    if (!configId) return
    const choice = {
      modelId: value,
      modelConfigId: catalog?.source === 'config' ? catalog.id : null
    }
    if (sw.blocked) {
      setQueryState('')
      setView(configId)
      setConfirm({ configId, pick: choice })
      return
    }
    // Chat: once armed, this tab is the composer's agent and the footer
    // shows its options. Launcher: selects the agent.
    sw.pickOtherModel(configId, choice)
    if (sw.selectAgent) setView(null)
  }

  // Launcher: a tab or an agent row selects that agent for the new chat.
  // Chat: it only shows that agent's models.
  const openAgent = (tab: AgentTab): void => {
    setConfirm(null)
    if (sw.selectAgent) {
      sw.selectAgent(tab)
      setView(null)
      return
    }
    setView(tab.configId)
  }

  const showMore = (): void => {
    setConfirm(null)
    setView(MORE_AGENTS_VIEW)
  }
  const waitForTurn = (): void => {
    setConfirm(null)
    onClose()
  }
  const cancelAndSwitch = (): void => {
    if (!confirm) return
    const chosen = confirm
    setConfirm(null)
    onClose()
    void sw.cancelThenSwitch(chosen.configId, chosen.pick)
  }

  const capabilities = capabilitySummary(props.capabilities)
  const modelChoices = modelOption ? catalogModels(modelOption) : []
  const effectiveCatalog: ModelCatalog | null = modelOption
    ? { id: modelOption.id, source: 'config', options: modelChoices, currentValue: null }
    : null

  const installView = (
    entry: SupportedAcpAgentEntry,
    tab: AgentTab,
    blocked: boolean
  ): PanelView => ({
    kind: 'install',
    tab,
    entry,
    installing: sw.installingConfigId === entry.configId,
    installBlocked:
      blocked || Boolean(sw.installingConfigId && sw.installingConfigId !== entry.configId),
    install: entry.install ? () => sw.install(entry) : null
  })

  let body: PanelView
  if (searching) {
    const own = modelChoices.filter((m) => modelMatches(m, query))
    const others = lookupIds.flatMap((configId) => {
      const catalog = knownById.get(configId)
      return catalog
        ? catalog.options
            .filter((m) => modelMatches(m, query))
            .map((model) => ({ configId, catalog, model }))
        : []
    })
    const needle = query.trim().toLowerCase()
    const agents = allTabs.filter(
      (t) => t.configId !== effectiveId && t.name.toLowerCase().includes(needle)
    )
    body = {
      kind: 'search',
      own,
      others,
      agents,
      count: own.length + others.length + agents.length
    }
  } else if (showingMore) {
    body = { kind: 'more', tabs: tabs.overflow }
  } else if (viewKind === 'effective' && viewEntry && viewEntry.status !== 'ready' && viewTab) {
    // Launcher: the selected agent is not installed yet.
    body = installView(viewEntry, viewTab, false)
  } else if (viewKind === 'effective') {
    const status = sw.modelStatus
    if (modelOption || !(status?.loading || status?.error)) {
      const catalogOf = (id: string): ModelCatalog | null =>
        id === effectiveId ? effectiveCatalog : (knownById.get(id) ?? null)
      body = {
        kind: 'effective',
        catalog: effectiveCatalog,
        favorites:
          modelOption && showFavorites
            ? resolveFavorites(favorites, catalogOf, (id) => {
                // Uninstalled agents hide their favorites; reinstalling shows them again.
                const tab = tabById.get(id)
                return tab ? isInstalledTab(tab) : false
              }).map(({ configId, model }) => ({
                configId,
                catalog: catalogOf(configId),
                model
              }))
            : [],
        stale: status?.stale && status.error ? status : null
      }
    } else if (status?.loading) {
      body = { kind: 'loading', title: `Loading ${nameOf(effectiveId)} models…` }
    } else {
      body = {
        kind: 'error',
        title: status?.error?.label ?? '',
        detail: status?.error?.detail,
        status,
        retry: null
      }
    }
  } else if (viewKind === 'current') {
    body = { kind: 'current', catalog: sw.liveCatalog }
  } else if (viewEntry && viewEntry.status !== 'ready' && viewTab) {
    body = installView(viewEntry, viewTab, sw.blocked)
  } else if (other.catalog) {
    body = {
      kind: 'other',
      catalog: other.catalog,
      confirming: Boolean(confirm && confirm.configId === viewId)
    }
  } else if (other.error) {
    body = {
      kind: 'error',
      title: `Could not load ${nameOf(viewId)} models.`,
      detail: other.error.label,
      status: null,
      retry: other.retry
    }
  } else {
    body = { kind: 'loading', title: `Loading ${nameOf(viewId)} models…` }
  }

  const ownFooter = searching || (!showingMore && viewId === effectiveId)
  const otherHintTab =
    !ownFooter && !showingMore && viewTab && (viewKind === 'current' || other.catalog)
      ? viewTab
      : null

  return {
    query,
    setQuery,
    searching,
    showingMore,
    effectiveId,
    viewId,
    viewTab,
    tabs,
    viewInOverflow,
    view: body,
    // The launcher selects an agent in place (its `view` stays null), so the
    // effective id is part of the key or a provider switch would not fade.
    listKey: searching ? 'search' : showingMore ? MORE_AGENTS_VIEW : (viewId ?? 'effective'),
    effectiveCatalog,
    capabilities,
    ownFooter,
    otherHintTab,
    contextUsage: shouldShowSessionUsage(props.usage ?? null, props.messages ?? []),
    pick,
    openAgent,
    showMore,
    waitForTurn,
    cancelAndSwitch,
    tabOf,
    nameOf,
    badgeOf,
    notSetUp,
    hasUpdate
  }
}
