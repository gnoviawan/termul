import { motion, useReducedMotion } from 'framer-motion'
import {
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { MoreHorizontal, Search } from '@/components/icons'
import type { SessionConfigOption, SessionUsage } from '@/lib/acp-api'
import type { SupportedAcpAgentEntry } from '@/lib/agents/supported-acp-agents'
import { cn } from '@/lib/utils'
import { shouldShowSessionUsage } from '../context-usage-utils'
import { SegmentedTrack, type TrackItem } from './SegmentedTrack'
import { SelectorFooter } from './SelectorFooter'
import {
  AgentRow,
  BusyBlock,
  ContextSummary,
  Hint,
  InstallState,
  ListMessage,
  ModelRow,
  StatusActions,
  TabGlyph
} from './SelectorRows'
import {
  type AgentTab,
  armableConfigId,
  buildAgentTabs,
  type CatalogModel,
  catalogModels,
  entryDisableReason,
  MORE_AGENTS_VIEW,
  type ModelCatalog,
  modelMatches
} from './selector-model'
import type { SelectorSource } from './selector-source'
import type { SwitchModelPick } from './use-agent-switch'
import { loadPersistedCatalog, useKnownCatalogs, useOtherAgentCatalog } from './use-model-catalog'

const NO_IDS: readonly string[] = []

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

export interface SelectorPanelProps {
  /** Where agents come from and where picks go (a chat, or the launcher). */
  source: SelectorSource
  touch: boolean
  disabled: boolean
  /** The composer's model option: the live agent, or the armed target. */
  modelOption: SessionConfigOption | null
  modelValue: string | undefined
  onPickModel: (value: string) => void
  thoughtLevel: SessionConfigOption | null
  effortValue: string | undefined
  onEffort: (value: string) => void
  fastMode: SessionConfigOption | null
  fastOn: boolean
  onToggleFast: (() => void) | null
  genericOptions: SessionConfigOption[]
  onSetConfig: (configId: string, valueId: string | boolean) => void | Promise<void>
  /** Session context usage for the summary row (chat only; launcher omits it). */
  usage?: SessionUsage | null
  messages?: ReadonlyArray<{ role: string }>
  onClose: () => void
  /** Set by the panel: clears its inner state on Escape; true when it did. */
  escapeRef: MutableRefObject<(() => boolean) | null>
}

/**
 * The selector content: search, agent tabs, the model list, and the footer.
 * A tab shows that agent's models in place (no flyout, width never changes).
 * Choosing another agent's model arms the switch with that model; the next
 * send runs it. Search covers the models of every agent with a known list.
 */
export function SelectorPanel(props: SelectorPanelProps): React.JSX.Element {
  const { source: sw, touch, disabled, modelOption, modelValue, onClose, escapeRef } = props
  const reduced = useReducedMotion() ?? false
  const [query, setQuery] = useState('')
  const [view, setView] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ configId: string; pick: SwitchModelPick } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const effectiveId = sw.armedConfigId ?? sw.currentConfigId
  const showingMore = view === MORE_AGENTS_VIEW
  const viewId = showingMore ? null : (view ?? effectiveId)
  const searching = query.trim().length > 0

  const tabs = useMemo(() => {
    const args = {
      currentConfigId: sw.currentConfigId,
      armedConfigId: sw.armedConfigId,
      viewConfigId: viewId,
      entries: sw.entries,
      agentConfigs: sw.agentConfigs
    }
    const first = buildAgentTabs(args)
    // Keep one column for "More" so the track stays on the 5-column grid.
    return first.overflow.length > 0 ? buildAgentTabs({ ...args, max: 3 }) : first
  }, [sw.currentConfigId, sw.armedConfigId, viewId, sw.entries, sw.agentConfigs])
  const allTabs = useMemo(() => [...tabs.visible, ...tabs.overflow], [tabs])
  const tabById = useMemo(() => new Map(allTabs.map((t) => [t.configId, t])), [allTabs])
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
  const viewTab = viewId ? (tabById.get(viewId) ?? null) : null
  const nameOf = (configId: string | null): string =>
    (configId && tabById.get(configId)?.name) || 'this agent'

  const tabIdsKey = allTabs.map((t) => t.configId).join('\n')
  useEffect(() => {
    for (const configId of tabIdsKey.split('\n')) if (configId) loadPersistedCatalog(configId)
  }, [tabIdsKey])

  // The chat's own agent while a switch to another agent is armed.
  const liveCatalog = sw.liveCatalog

  const viewKind: 'effective' | 'current' | 'other' =
    viewId === effectiveId ? 'effective' : viewId === sw.currentConfigId ? 'current' : 'other'
  const viewEntry = viewTab?.entry ?? null
  const viewReady = viewEntry ? viewEntry.status === 'ready' : Boolean(viewTab?.config)
  const other = useOtherAgentCatalog(
    sw.workspace,
    !searching && viewKind === 'other' && viewReady ? viewId : null,
    true
  )

  const searchIds = useMemo(
    () => (searching ? allTabs.map((t) => t.configId).filter((id) => id !== effectiveId) : NO_IDS),
    [searching, allTabs, effectiveId]
  )
  const known = useKnownCatalogs(sw.workspace.cwd, searchIds)

  escapeRef.current = () => {
    if (confirm) {
      setConfirm(null)
      return true
    }
    if (query) {
      setQuery('')
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
      setQuery('')
      setView(configId)
      setConfirm({ configId, pick: choice })
      return
    }
    // Chat: once armed, this tab is the composer's agent and the footer
    // shows its Effort and Fast options. Launcher: selects the agent.
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

  const rows = (
    configId: string | null,
    catalog: ModelCatalog | null,
    options: CatalogModel[],
    selectedValue: string | undefined,
    tab: AgentTab | null,
    showAgent: boolean
  ): ReactNode =>
    options.map((model) => (
      <ModelRow
        key={`${configId}\0${model.value}`}
        name={model.name}
        description={model.description}
        selected={model.value === selectedValue}
        glyph={showAgent && tab ? <TabGlyph tab={tab} /> : undefined}
        meta={showAgent && configId !== effectiveId ? tab?.name : undefined}
        disabled={disabled}
        touch={touch}
        onPick={() => pick(configId, catalog, model.value)}
      />
    ))

  const effectiveCatalog: ModelCatalog | null = modelOption
    ? {
        id: modelOption.id,
        source: 'config',
        options: catalogModels(modelOption),
        currentValue: null
      }
    : null
  const modelChoices = modelOption ? catalogModels(modelOption) : []

  let body: ReactNode
  let resultCount = 0
  if (searching) {
    const effectiveTab = effectiveId ? (tabById.get(effectiveId) ?? null) : null
    const own = modelChoices.filter((m) => modelMatches(m, query))
    const others = searchIds.flatMap((id, i) => {
      const catalog = known[i]
      return catalog
        ? catalog.options.filter((m) => modelMatches(m, query)).map((m) => ({ id, catalog, m }))
        : []
    })
    const agents = allTabs.filter(
      (t) => t.configId !== effectiveId && t.name.toLowerCase().includes(query.trim().toLowerCase())
    )
    resultCount = own.length + others.length + agents.length
    body =
      resultCount === 0 ? (
        <ListMessage title="No models or agents match." detail="Try another name." />
      ) : (
        <>
          {rows(effectiveId, effectiveCatalog, own, modelValue, effectiveTab, true)}
          {others.map(({ id, catalog, m }) =>
            rows(id, catalog, [m], undefined, tabById.get(id) ?? null, true)
          )}
          {agents.map((tab) => (
            <AgentRow
              key={`agent\0${tab.configId}`}
              tab={tab}
              badge={badgeOf(tab)}
              disabled={disabled || notSetUp(tab)}
              touch={touch}
              onPick={() => {
                setQuery('')
                openAgent(tab)
              }}
            />
          ))}
        </>
      )
  } else if (showingMore) {
    body = tabs.overflow.map((tab) => (
      <AgentRow
        key={tab.configId}
        tab={tab}
        badge={badgeOf(tab)}
        disabled={disabled || notSetUp(tab)}
        touch={touch}
        onPick={() => openAgent(tab)}
      />
    ))
  } else if (viewKind === 'effective' && viewEntry && viewEntry.status !== 'ready' && viewTab) {
    // Launcher: the selected agent is not installed yet.
    body = (
      <InstallState
        tab={viewTab}
        reason={entryDisableReason(viewEntry)}
        installing={sw.installingConfigId === viewEntry.configId}
        installBlocked={Boolean(
          sw.installingConfigId && sw.installingConfigId !== viewEntry.configId
        )}
        touch={touch}
        onInstall={viewEntry.install ? () => sw.install(viewEntry) : null}
      />
    )
  } else if (viewKind === 'effective') {
    const status = sw.modelStatus
    if (modelOption) {
      body = (
        <>
          {rows(effectiveId, effectiveCatalog, modelChoices, modelValue, viewTab, false)}
          {status?.stale && status.error ? (
            <StatusActions
              title={`${status.error.label}. These models are from the last session.`}
              detail={status.error.detail}
              status={status}
              touch={touch}
              compact
            />
          ) : null}
        </>
      )
    } else if (status?.loading) {
      body = <ListMessage loading title={`Loading ${nameOf(effectiveId)} models…`} />
    } else if (status?.error) {
      body = (
        <StatusActions
          title={status.error.label}
          detail={status.error.detail}
          status={status}
          touch={touch}
        />
      )
    } else {
      body = <ListMessage title="This agent gives no model choice." />
    }
  } else if (viewKind === 'current') {
    body = (
      <>
        {liveCatalog ? (
          rows(viewId, liveCatalog, liveCatalog.options, undefined, viewTab, false)
        ) : (
          <ListMessage title={`${nameOf(viewId)} gives no model choice.`} />
        )}
        <Hint>{`Keeps ${nameOf(viewId)} and cancels the switch to ${nameOf(sw.armedConfigId)}.`}</Hint>
      </>
    )
  } else if (viewEntry && viewEntry.status !== 'ready' && viewTab) {
    const spec = viewEntry.install
    body = (
      <InstallState
        tab={viewTab}
        reason={entryDisableReason(viewEntry)}
        installing={sw.installingConfigId === viewEntry.configId}
        installBlocked={
          sw.blocked ||
          Boolean(sw.installingConfigId && sw.installingConfigId !== viewEntry.configId)
        }
        touch={touch}
        onInstall={spec ? () => sw.install(viewEntry) : null}
      />
    )
  } else if (other.catalog) {
    body = (
      <>
        {rows(viewId, other.catalog, other.catalog.options, undefined, viewTab, false)}
        {confirm && confirm.configId === viewId ? (
          <BusyBlock
            agentName={nameOf(sw.currentConfigId)}
            canCancel={sw.turnBusy}
            touch={touch}
            onWait={() => {
              setConfirm(null)
              onClose()
            }}
            onCancelAndSwitch={() => {
              const chosen = confirm
              setConfirm(null)
              onClose()
              void sw.cancelThenSwitch(chosen.configId, chosen.pick)
            }}
          />
        ) : (
          <Hint>{`Switches to ${nameOf(viewId)} on the next send`}</Hint>
        )}
      </>
    )
  } else if (other.error) {
    body = (
      <div className="flex flex-col gap-2">
        <ListMessage
          title={`Could not load ${nameOf(viewId)} models.`}
          detail={other.error.label}
        />
        <SegmentedTrack
          id="retry-models"
          label="Retry"
          touch={touch}
          items={[
            { key: 'retry', label: 'Try again', span: 5, selected: true, onSelect: other.retry }
          ]}
        />
      </div>
    )
  } else {
    body = <ListMessage loading title={`Loading ${nameOf(viewId)} models…`} />
  }

  const tabItems: TrackItem[] = tabs.visible.map((tab) => {
    const selected = !showingMore && tab.configId === viewId
    return {
      key: tab.configId,
      span: selected ? 2 : 1,
      selected,
      ariaLabel: tab.name,
      title: hasUpdate(tab) ? `${tab.name} · update available` : tab.name,
      label: selected ? (
        <>
          <TabGlyph tab={tab} />
          <span className="truncate">{tab.name}</span>
        </>
      ) : (
        <TabGlyph tab={tab} />
      ),
      disabled,
      onSelect: () => openAgent(tab),
      testId: `agent-tab-${tab.configId}`
    }
  })
  if (tabs.overflow.length > 0) {
    tabItems.push({
      key: 'more',
      span: showingMore ? 2 : 1,
      selected: showingMore,
      ariaLabel: 'More agents',
      title: 'More agents',
      label: (
        <>
          <MoreHorizontal size={14} aria-hidden="true" />
          {showingMore ? 'More' : null}
        </>
      ),
      disabled,
      onSelect: () => {
        setConfirm(null)
        setView(MORE_AGENTS_VIEW)
      },
      testId: 'agent-tab-more'
    })
  }
  const showTabs = !searching && tabItems.length > 1

  const rowsOf = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-selector-row]') ?? [])
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'ArrowDown') return
    const first = rowsOf().find((row) => !row.hasAttribute('disabled'))
    if (!first) return
    event.preventDefault()
    first.focus()
  }
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const all = rowsOf()
    const index = all.indexOf(event.target as HTMLElement)
    if (index < 0) return
    event.preventDefault()
    if (event.key === 'ArrowUp' && index === 0) {
      searchRef.current?.focus()
      return
    }
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, all.length - 1) : index - 1
    all[next]?.focus()
  }

  const pad = touch ? 'px-3' : 'px-1'
  const footer = (
    <SelectorFooter
      thoughtLevel={props.thoughtLevel}
      effortValue={props.effortValue}
      onEffort={props.onEffort}
      fastMode={props.fastMode}
      fastOn={props.fastOn}
      onToggleFast={props.onToggleFast}
      genericOptions={props.genericOptions}
      onSetConfig={props.onSetConfig}
      disabled={disabled}
      touch={touch}
    />
  )
  // The footer controls the composer's agent only. Another agent's tab shows
  // how to reach its options instead of the wrong agent's controls.
  const ownFooter = searching || (!showingMore && viewId === effectiveId)
  const hasOwnOptions =
    Boolean(props.thoughtLevel || props.fastMode) || props.genericOptions.length > 0
  const contextUsage = shouldShowSessionUsage(props.usage ?? null, props.messages ?? [])
  const otherHint =
    !ownFooter && !showingMore && viewTab && (viewKind === 'current' || other.catalog)
      ? `Choose a model to set Effort and Fast for ${viewTab.name}.`
      : null

  return (
    <div data-testid="agent-model-selector-panel" className={cn('flex flex-col', !touch && 'w-80')}>
      {/* On touch the sheet's 44px close box sits in the top-right 46px, so the
          row's right padding (pr-12) keeps the field and the result count clear. */}
      <div className={cn('flex items-center gap-2', touch ? 'h-12 pl-5 pr-12' : 'h-10 px-3')}>
        <Search
          size={touch ? 16 : 14}
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
        />
        <input
          ref={searchRef}
          // biome-ignore lint/a11y/noAutofocus: the selector opens to search, like a command list
          autoFocus={!touch}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setConfirm(null)
          }}
          onKeyDown={onSearchKeyDown}
          placeholder="Search models…"
          aria-label="Search models and agents"
          className={cn(
            'min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground',
            touch ? 'text-base' : 'text-sm'
          )}
        />
        {searching ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{resultCount}</span>
        ) : null}
      </div>
      <div className="h-px bg-border" />
      {showTabs ? (
        <div className={cn(pad, touch ? 'pt-2' : 'pt-1')}>
          <SegmentedTrack
            id={`agent-tabs-${sw.key}`}
            label="Agents"
            semantics="tabs"
            touch={touch}
            items={tabItems}
          />
        </div>
      ) : null}
      <motion.div
        ref={listRef}
        // The list crossfades when its content identity changes: the viewed
        // agent (`view`), or the effective agent. The launcher selects an
        // agent in place — its `view` stays null — so the effective id must
        // be part of the key or a provider switch would swap the rows with
        // no transition at all.
        key={searching ? 'search' : showingMore ? MORE_AGENTS_VIEW : (viewId ?? 'effective')}
        role={showTabs ? 'tabpanel' : undefined}
        data-testid="selector-list"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reduced ? 0 : 0.15, ease: 'easeOut' }}
        onKeyDown={onListKeyDown}
        className={cn(
          'max-h-64 overflow-y-auto overscroll-contain',
          pad,
          touch ? 'py-1.5' : 'py-1'
        )}
      >
        {body}
      </motion.div>
      {!searching && contextUsage ? (
        <>
          <div className="h-px bg-border" />
          <ContextSummary usage={contextUsage} touch={touch} />
        </>
      ) : null}
      {ownFooter && hasOwnOptions ? (
        <>
          <div className="h-px bg-border" />
          {footer}
        </>
      ) : null}
      {otherHint ? (
        <>
          <div className="h-px bg-border" />
          <p
            className={cn(
              'flex items-center text-xs text-muted-foreground',
              touch ? 'min-h-12 px-5' : 'min-h-9 px-3'
            )}
          >
            {otherHint}
          </p>
        </>
      ) : null}
    </div>
  )
}
