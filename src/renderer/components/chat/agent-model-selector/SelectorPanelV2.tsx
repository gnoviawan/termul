import { motion, useReducedMotion } from 'framer-motion'
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Check, MoreHorizontal, Search } from '@/components/icons'
import { BAND_FOCUS_CLASS, INNER_FIELD_FOCUS_CLASS } from '@/components/ui/panel-styles'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SessionConfigOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { flattenConfigOptionValues } from '../chat-input-bar-config'
import { shouldShowSessionUsage } from '../context-usage-utils'
import {
  type ChoiceSection,
  DENSE_ROW,
  denseRowSize,
  EditableRow,
  type EditRowHandle,
  moveFocus,
  type OptionChoice,
  OptionRow,
  OptionSwitchRow,
  ROW_FOCUS
} from './SelectorOptionRows'
import { type SelectorPanelProps, statusBadge } from './SelectorPanel'
import {
  AgentRow,
  BusyBlock,
  ContextSummary,
  Hint,
  InstallState,
  ListMessage,
  StatusActions,
  TabGlyph
} from './SelectorRows'
import {
  type AgentTab,
  armableConfigId,
  buildAgentTabs,
  type CatalogModel,
  capabilitySummary,
  catalogModels,
  entryDisableReason,
  type FavoriteModel,
  MORE_AGENTS_VIEW,
  type ModelCatalog,
  modelMatches,
  resolveFavorites,
  splitContextOption
} from './selector-model'
import type { SwitchModelPick } from './use-agent-switch'
import { loadPersistedCatalog, useKnownCatalogs, useOtherAgentCatalog } from './use-model-catalog'

const NO_IDS: readonly string[] = []
const NO_FAVORITES: readonly FavoriteModel[] = []
const LIST_ROW = '[data-selector-row]'
/** `--ease-smooth-out`; framer needs the curve itself, not the variable. */
const EASE_OUT = [0.22, 1, 0.36, 1] as const
const quick = (reduced: boolean) => ({ duration: reduced ? 0 : 0.15, ease: EASE_OUT })

export interface SelectorPanelV2Props extends SelectorPanelProps {
  /**
   * Starred models, keyed by the store config id (`armableConfigId`). Shown
   * as a section above the list. Empty until the favorites store lands.
   */
  favorites?: readonly FavoriteModel[]
}

function SectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="truncate px-2 pb-1 pt-2 text-xs text-muted-foreground">{children}</div>
}

function DenseModelRow({
  name,
  tooltip,
  selected,
  glyph,
  agentName,
  edit,
  disabled,
  touch,
  onPick
}: {
  name: string
  tooltip?: string
  selected: boolean
  glyph?: ReactNode
  /** Another agent's model: named for screen readers; the glyph shows it. */
  agentName?: string
  /** Session options of the active model; adds the Edit button. */
  edit?: ChoiceSection[]
  disabled: boolean
  touch: boolean
  onPick: () => void
}): React.JSX.Element {
  const editable = Boolean(edit && edit.length > 0)
  const renderRow = (handle?: EditRowHandle): React.JSX.Element => {
    const button = (
      <button
        ref={handle?.ref}
        type="button"
        data-selector-row=""
        aria-pressed={selected}
        disabled={disabled}
        onClick={onPick}
        onKeyDown={handle?.onKeyDown}
        // On an editable row the hover belongs to the row around both buttons.
        className={cn(
          DENSE_ROW,
          denseRowSize(touch),
          editable && 'min-w-0 flex-1 hover:bg-transparent'
        )}
      >
        {glyph ? <span className="inline-flex shrink-0">{glyph}</span> : null}
        <span className="min-w-0 flex-1 truncate">
          {name}
          {agentName ? <span className="sr-only">{` · ${agentName}`}</span> : null}
        </span>
        <Check
          size={14}
          aria-hidden="true"
          className={cn('shrink-0', selected ? 'opacity-100' : 'opacity-0')}
        />
      </button>
    )
    const tip = [agentName, tooltip].filter(Boolean).join('\n\n')
    if (!tip || touch) return button
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-64 whitespace-pre-line">
          {tip}
        </TooltipContent>
      </Tooltip>
    )
  }
  if (!edit || !editable) return renderRow()
  return (
    <EditableRow
      modelName={name}
      sections={edit}
      disabled={disabled}
      touch={touch}
      renderRow={renderRow}
    />
  )
}

interface TabItem {
  key: string
  label: string
  glyph: ReactNode
  selected: boolean
  title: string
  onSelect: () => void
}

/**
 * Agent tabs as glyphs over a hairline, the active one marked by a 2px
 * underline that slides between tabs. Tabs pattern: one tab stop (the
 * selected tab), Left/Right/Home/End move focus, Enter or Space selects.
 */
function AgentTabStrip({
  id,
  items,
  disabled,
  touch,
  reduced
}: {
  id: string
  items: TabItem[]
  disabled: boolean
  touch: boolean
  reduced: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // One tab stop: the selected tab, or the first when none is selected.
  const stop = Math.max(
    items.findIndex((item) => item.selected),
    0
  )
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const tabs = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
    const index = tabs.indexOf(document.activeElement as HTMLElement)
    if (index < 0) return
    const last = tabs.length - 1
    const next =
      event.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (next == null) return
    event.preventDefault()
    tabs[next]?.focus()
  }
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label="Agents"
      onKeyDown={onKeyDown}
      className={cn('flex border-b border-border', touch ? 'px-3' : 'px-1')}
    >
      {items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.selected}
          aria-label={item.label}
          title={item.title}
          tabIndex={index === stop ? 0 : -1}
          disabled={disabled}
          data-testid={`agent-tab-${item.key}`}
          onClick={item.onSelect}
          className={cn(
            'relative flex flex-1 items-center justify-center rounded-t-md transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-60',
            touch ? 'h-11' : 'h-8',
            item.selected
              ? 'text-foreground'
              : 'text-muted-foreground hover:bg-row-hover hover:text-foreground',
            ROW_FOCUS
          )}
        >
          {item.glyph}
          {item.selected ? (
            <motion.span
              layoutId={`${id}-underline`}
              aria-hidden="true"
              transition={quick(reduced)}
              className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground"
            />
          ) : null}
        </button>
      ))}
    </div>
  )
}

const optionChoices = (option: SessionConfigOption): OptionChoice[] =>
  flattenConfigOptionValues(option).map(({ value, name, description }) => ({
    value,
    name,
    description: description ?? undefined
  }))

/**
 * The active model's Edit flyout sections: Thinking (the effort option),
 * Context, Fast. Each shows only when the agent sends that option, with value
 * labels from the option data.
 */
function editSections(
  props: SelectorPanelV2Props,
  context: SessionConfigOption | null
): ChoiceSection[] {
  const sections: ChoiceSection[] = []
  const thinking = props.thoughtLevel ? optionChoices(props.thoughtLevel) : []
  if (thinking.length > 0) {
    sections.push({
      kind: 'radio',
      id: 'thinking',
      label: 'Thinking',
      value: props.effortValue,
      choices: thinking,
      onPick: props.onEffort
    })
  }
  const windows = context ? optionChoices(context) : []
  if (context && windows.length > 0) {
    sections.push({
      kind: 'radio',
      id: 'context',
      label: 'Context',
      value: String(context.currentValue),
      choices: windows,
      onPick: (value) => void props.onSetConfig(context.id, value)
    })
  }
  if (props.fastMode && props.onToggleFast) {
    sections.push({
      kind: 'toggle',
      id: 'fast',
      label: 'Fast',
      checked: props.fastOn,
      onToggle: props.onToggleFast
    })
  }
  return sections
}

/**
 * The agent's other session options, one footer row each, shown only when
 * the agent sends them.
 */
function SessionOptions({
  rest,
  ...props
}: SelectorPanelV2Props & { rest: SessionConfigOption[] }): React.JSX.Element | null {
  const { touch, disabled } = props
  const ref = useRef<HTMLFieldSetElement>(null)
  const rows: ReactNode[] = []
  for (const option of rest) {
    if (option.type === 'boolean') {
      const checked = option.currentValue === true
      rows.push(
        <OptionSwitchRow
          key={option.id}
          id={option.id}
          label={option.name}
          checked={checked}
          disabled={disabled}
          touch={touch}
          onToggle={() => void props.onSetConfig(option.id, !checked)}
        />
      )
      continue
    }
    const choices = optionChoices(option)
    if (choices.length === 0) continue
    rows.push(
      <OptionRow
        key={option.id}
        id={option.id}
        label={option.name}
        value={String(option.currentValue)}
        choices={choices}
        disabled={disabled}
        touch={touch}
        onSelect={(value) => void props.onSetConfig(option.id, value)}
      />
    )
  }
  if (rows.length === 0) return null
  return (
    <fieldset
      ref={ref}
      aria-label="Session options"
      data-testid="selector-options"
      onKeyDown={(event) => {
        moveFocus(event, ref.current, '[data-option-row]')
      }}
      className={cn('flex min-w-0 flex-col border-t border-border', touch ? 'px-3 py-1.5' : 'p-1')}
    >
      {rows}
    </fieldset>
  )
}

/**
 * Model picker v2 (view only): the same source, picks and states as
 * `SelectorPanel` in a denser layout. Glyph tabs with an underline, a
 * Favorites section, 28px rows, and an Edit flyout on the active model for
 * Thinking, Context and Fast. Visual direction after volt (MIT,
 * github.com/LeulAria/volt), on Termul tokens.
 */
export function SelectorPanelV2(props: SelectorPanelV2Props): React.JSX.Element {
  const { source: sw, touch, disabled, modelOption, modelValue, onClose, escapeRef } = props
  const favorites = props.favorites ?? NO_FAVORITES
  const reduced = useReducedMotion() ?? false
  const [query, setQuery] = useState('')
  const [view, setView] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ configId: string; pick: SwitchModelPick } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const effectiveId = sw.armedConfigId ?? sw.currentConfigId
  const showingMore = view === MORE_AGENTS_VIEW
  const viewId = showingMore ? null : (view ?? effectiveId)
  const searching = query.trim().length > 0

  const tabs = useMemo(
    () =>
      buildAgentTabs({
        currentConfigId: sw.currentConfigId,
        armedConfigId: sw.armedConfigId,
        viewConfigId: viewId,
        entries: sw.entries,
        agentConfigs: sw.agentConfigs
      }),
    [sw.currentConfigId, sw.armedConfigId, viewId, sw.entries, sw.agentConfigs]
  )
  const allTabs = useMemo(() => [...tabs.visible, ...tabs.overflow], [tabs])
  const tabById = useMemo(() => new Map(allTabs.map((t) => [t.configId, t])), [allTabs])
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

  const showFavorites = !searching && viewKind === 'effective' && favorites.length > 0
  const favoriteIdsKey = favorites.map((f) => f.configId).join('\n')
  const lookupIds = useMemo(() => {
    const ids = new Set<string>()
    if (searching) {
      for (const t of allTabs) if (t.configId !== effectiveId) ids.add(t.configId)
    }
    if (showFavorites) {
      for (const id of favoriteIdsKey.split('\n')) if (id && id !== effectiveId) ids.add(id)
    }
    return ids.size > 0 ? [...ids] : NO_IDS
  }, [searching, showFavorites, allTabs, effectiveId, favoriteIdsKey])
  const known = useKnownCatalogs(sw.workspace.cwd, lookupIds)
  const knownById = new Map(lookupIds.map((id, i) => [id, known[i] ?? null]))

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

  // Same picks as SelectorPanel: a model pick never closes the panel.
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
    sw.pickOtherModel(configId, choice)
    if (sw.selectAgent) setView(null)
  }

  const openAgent = (tab: AgentTab): void => {
    setConfirm(null)
    if (sw.selectAgent) {
      sw.selectAgent(tab)
      setView(null)
      return
    }
    setView(tab.configId)
  }

  const capabilities = capabilitySummary(props.capabilities)
  const { context, rest } = splitContextOption(props.genericOptions)
  const edit = editSections(props, context)
  const rows = (
    configId: string | null,
    catalog: ModelCatalog | null,
    options: CatalogModel[],
    selectedValue: string | undefined,
    tab: AgentTab | null,
    showAgent: boolean,
    keyPrefix = ''
  ): ReactNode =>
    options.map((model) => (
      <DenseModelRow
        key={`${keyPrefix}${configId}\0${model.value}`}
        name={model.name}
        tooltip={
          [model.description, configId === sw.currentConfigId ? capabilities : null]
            .filter(Boolean)
            .join('\n\n') || undefined
        }
        selected={model.value === selectedValue}
        glyph={showAgent && tab ? <TabGlyph tab={tab} /> : undefined}
        agentName={showAgent && configId !== effectiveId ? tab?.name : undefined}
        // Only the active model has session options; a favorite repeats it without Edit.
        edit={
          configId === effectiveId && model.value === selectedValue && !keyPrefix ? edit : undefined
        }
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

  const favoriteRows = showFavorites
    ? resolveFavorites(favorites, (id) =>
        id === effectiveId ? effectiveCatalog : (knownById.get(id) ?? null)
      ).map((favorite) =>
        rows(
          favorite.configId,
          favorite.configId === effectiveId
            ? effectiveCatalog
            : (knownById.get(favorite.configId) ?? null),
          [favorite.model],
          favorite.configId === effectiveId ? modelValue : undefined,
          tabById.get(favorite.configId) ?? null,
          true,
          'favorite\0'
        )
      )
    : []

  let body: ReactNode
  let resultCount = 0
  if (searching) {
    const effectiveTab = effectiveId ? (tabById.get(effectiveId) ?? null) : null
    const own = modelChoices.filter((m) => modelMatches(m, query))
    const others = lookupIds.flatMap((id) => {
      const catalog = knownById.get(id)
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
          {favoriteRows.length > 0 ? (
            <>
              <SectionLabel>Favorites</SectionLabel>
              {favoriteRows}
              <SectionLabel>{viewTab?.name ?? 'Models'}</SectionLabel>
            </>
          ) : null}
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
      body = (
        <ListMessage
          title="This agent gives no model choice."
          detail={effectiveId === sw.currentConfigId ? (capabilities ?? undefined) : undefined}
        />
      )
    }
  } else if (viewKind === 'current') {
    body = (
      <>
        {liveCatalog ? (
          rows(viewId, liveCatalog, liveCatalog.options, undefined, viewTab, false)
        ) : (
          <ListMessage
            title={`${nameOf(viewId)} gives no model choice.`}
            detail={capabilities ?? undefined}
          />
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
      <div className="flex flex-col gap-1">
        <ListMessage
          title={`Could not load ${nameOf(viewId)} models.`}
          detail={other.error.label}
        />
        <button
          type="button"
          onClick={other.retry}
          className={cn(DENSE_ROW, denseRowSize(touch), 'justify-center')}
        >
          Try again
        </button>
      </div>
    )
  } else {
    body = <ListMessage loading title={`Loading ${nameOf(viewId)} models…`} />
  }

  const tabItems: TabItem[] = tabs.visible.map((tab) => ({
    key: tab.configId,
    label: tab.name,
    glyph: <TabGlyph tab={tab} />,
    selected: !showingMore && tab.configId === viewId,
    title: hasUpdate(tab) ? `${tab.name} · update available` : tab.name,
    onSelect: () => openAgent(tab)
  }))
  if (tabs.overflow.length > 0) {
    tabItems.push({
      key: 'more',
      label: 'More agents',
      glyph: <MoreHorizontal size={14} aria-hidden="true" />,
      selected: showingMore,
      title: 'More agents',
      onSelect: () => {
        setConfirm(null)
        setView(MORE_AGENTS_VIEW)
      }
    })
  }
  const showTabs = !searching && tabItems.length > 1

  const listKey = searching ? 'search' : showingMore ? MORE_AGENTS_VIEW : (viewId ?? 'effective')
  // The list remounts per view (`key`), so this runs once per view: open on
  // the chosen model even when it sits below the fold.
  const attachList = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node
    const chosen = node?.querySelectorAll<HTMLElement>(`${LIST_ROW}[aria-pressed="true"]`)
    chosen?.[chosen.length - 1]?.scrollIntoView?.({ block: 'nearest' }) // jsdom has none
  }, [])

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'ArrowDown') return
    const first = Array.from(listRef.current?.querySelectorAll<HTMLElement>(LIST_ROW) ?? []).find(
      (row) => !row.hasAttribute('disabled')
    )
    if (!first) return
    event.preventDefault()
    first.focus()
  }
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const first = listRef.current?.querySelector<HTMLElement>(LIST_ROW)
    if (event.key === 'ArrowUp' && document.activeElement === first) {
      event.preventDefault()
      searchRef.current?.focus()
      return
    }
    moveFocus(event, listRef.current, LIST_ROW)
  }

  const pad = touch ? 'px-3' : 'px-1'
  const ownFooter = searching || (!showingMore && viewId === effectiveId)
  const contextUsage = shouldShowSessionUsage(props.usage ?? null, props.messages ?? [])
  const otherHint =
    !ownFooter && !showingMore && viewTab && (viewKind === 'current' || other.catalog)
      ? `Choose a model to set Thinking and Fast for ${viewTab.name}.`
      : null

  return (
    <div
      data-testid="agent-model-selector-panel"
      data-variant="v2"
      className={cn('flex min-h-0 flex-col', !touch && 'w-75')}
    >
      <div
        className={cn(
          'flex items-center gap-2 border-b border-border transition-colors duration-150 ease-out',
          BAND_FOCUS_CLASS,
          touch ? 'h-12 px-5' : 'h-9 px-3'
        )}
      >
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
            `min-w-0 flex-1 bg-transparent text-foreground placeholder:text-muted-foreground ${INNER_FIELD_FOCUS_CLASS}`,
            touch ? 'text-base' : 'text-sm'
          )}
        />
        {searching ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{resultCount}</span>
        ) : null}
      </div>
      {showTabs ? (
        <AgentTabStrip
          id={`agent-tabs-${sw.key}`}
          items={tabItems}
          disabled={disabled}
          touch={touch}
          reduced={reduced}
        />
      ) : null}
      <motion.div
        ref={attachList}
        key={listKey}
        role={showTabs ? 'tabpanel' : undefined}
        aria-label={showTabs ? (showingMore ? 'More agents' : viewTab?.name) : undefined}
        data-testid="selector-list"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={quick(reduced)}
        onKeyDown={onListKeyDown}
        className={cn('max-h-72 overflow-y-auto overscroll-contain', pad, 'py-1')}
      >
        {body}
      </motion.div>
      {!searching && contextUsage ? (
        <>
          <div className="h-px bg-border" />
          <ContextSummary usage={contextUsage} touch={touch} />
        </>
      ) : null}
      {ownFooter ? <SessionOptions {...props} rest={rest} /> : null}
      {otherHint ? (
        <p
          className={cn(
            'flex items-center border-t border-border text-xs text-muted-foreground',
            touch ? 'min-h-12 px-5' : 'min-h-9 px-3'
          )}
        >
          {otherHint}
        </p>
      ) : null}
    </div>
  )
}
