import { motion, useReducedMotion } from 'framer-motion'
import { type KeyboardEvent, type MutableRefObject, type ReactNode, useRef } from 'react'
import { MoreHorizontal, Search } from '@/components/icons'
import { INNER_FIELD_FOCUS_CLASS } from '@/components/ui/panel-styles'
import type { AgentCapabilities, SessionConfigOption, SessionUsage } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
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
  type CatalogModel,
  entryDisableReason,
  type ModelCatalog
} from './selector-model'
import type { SelectorSource } from './selector-source'
import { useSelectorPanelState } from './use-selector-panel-state'

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
  /** The effective agent's config id; keys persisted option-value rejections. */
  agentConfigId: string | null
  onSetConfig: (configId: string, valueId: string | boolean) => void | Promise<void>
  /** Session context usage for the summary row (chat only; launcher omits it). */
  usage?: SessionUsage | null
  messages?: ReadonlyArray<{ role: string }>
  /** What the chat's agent advertised (chat only; the launcher omits it). */
  capabilities?: AgentCapabilities | null
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
  const { source: sw, touch, disabled, modelValue } = props
  const reduced = useReducedMotion() ?? false
  const state = useSelectorPanelState(props, { reserveMoreTab: true })
  const { query, searching, showingMore, effectiveId, viewId, viewTab, tabs, view } = state
  const { pick, openAgent, nameOf, badgeOf, notSetUp, hasUpdate, capabilities } = state
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Capabilities belong to the chat's agent, so only its rows carry them.
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
        tooltip={
          [model.description, configId === sw.currentConfigId ? capabilities : null]
            .filter(Boolean)
            .join('\n\n') || undefined
        }
        selected={model.value === selectedValue}
        glyph={showAgent && tab ? <TabGlyph tab={tab} /> : undefined}
        meta={showAgent && configId !== effectiveId ? tab?.name : undefined}
        disabled={disabled}
        touch={touch}
        onPick={() => pick(configId, catalog, model.value)}
      />
    ))
  const agentRow = (tab: AgentTab, onPick: () => void, key = tab.configId): ReactNode => (
    <AgentRow
      key={key}
      tab={tab}
      badge={badgeOf(tab)}
      disabled={disabled || notSetUp(tab)}
      touch={touch}
      onPick={onPick}
    />
  )

  let body: ReactNode
  switch (view.kind) {
    case 'search':
      body =
        view.count === 0 ? (
          <ListMessage title="No models or agents match." detail="Try another name." />
        ) : (
          <>
            {rows(
              effectiveId,
              state.effectiveCatalog,
              view.own,
              modelValue,
              state.tabOf(effectiveId),
              true
            )}
            {view.others.map((hit) =>
              rows(
                hit.configId,
                hit.catalog,
                [hit.model],
                undefined,
                state.tabOf(hit.configId),
                true
              )
            )}
            {view.agents.map((tab) =>
              agentRow(
                tab,
                () => {
                  state.setQuery('')
                  openAgent(tab)
                },
                `agent\0${tab.configId}`
              )
            )}
          </>
        )
      break
    case 'more':
      body = view.tabs.map((tab) => agentRow(tab, () => openAgent(tab)))
      break
    case 'install':
      body = (
        <InstallState
          tab={view.tab}
          reason={entryDisableReason(view.entry)}
          installing={view.installing}
          installBlocked={view.installBlocked}
          touch={touch}
          onInstall={view.install}
        />
      )
      break
    case 'effective':
      body = view.catalog ? (
        <>
          {rows(effectiveId, view.catalog, view.catalog.options, modelValue, viewTab, false)}
          {view.stale?.error ? (
            <StatusActions
              title={`${view.stale.error.label}. These models are from the last session.`}
              detail={view.stale.error.detail}
              status={view.stale}
              touch={touch}
              compact
            />
          ) : null}
        </>
      ) : (
        <ListMessage
          title="This agent gives no model choice."
          detail={effectiveId === sw.currentConfigId ? (capabilities ?? undefined) : undefined}
        />
      )
      break
    case 'current':
      body = (
        <>
          {view.catalog ? (
            rows(viewId, view.catalog, view.catalog.options, undefined, viewTab, false)
          ) : (
            <ListMessage
              title={`${nameOf(viewId)} gives no model choice.`}
              detail={capabilities ?? undefined}
            />
          )}
          <Hint>{`Keeps ${nameOf(viewId)} and cancels the switch to ${nameOf(sw.armedConfigId)}.`}</Hint>
        </>
      )
      break
    case 'other':
      body = (
        <>
          {rows(viewId, view.catalog, view.catalog.options, undefined, viewTab, false)}
          {view.confirming ? (
            <BusyBlock
              agentName={nameOf(sw.currentConfigId)}
              canCancel={sw.turnBusy}
              touch={touch}
              onWait={state.waitForTurn}
              onCancelAndSwitch={state.cancelAndSwitch}
            />
          ) : (
            <Hint>{`Switches to ${nameOf(viewId)} on the next send`}</Hint>
          )}
        </>
      )
      break
    case 'error':
      body = view.status ? (
        <StatusActions title={view.title} detail={view.detail} status={view.status} touch={touch} />
      ) : (
        <div className="flex flex-col gap-2">
          <ListMessage title={view.title} detail={view.detail} />
          {view.retry ? (
            <SegmentedTrack
              id="retry-models"
              label="Retry"
              touch={touch}
              items={[
                { key: 'retry', label: 'Try again', span: 5, selected: true, onSelect: view.retry }
              ]}
            />
          ) : null}
        </div>
      )
      break
    case 'loading':
      body = <ListMessage loading title={view.title} />
      break
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
      onSelect: state.showMore,
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
      agentConfigId={effectiveId}
    />
  )
  // The footer controls the composer's agent only. Another agent's tab shows
  // how to reach its options instead of the wrong agent's controls.
  const hasOwnOptions =
    Boolean(props.thoughtLevel || props.fastMode) || props.genericOptions.length > 0
  const { ownFooter, contextUsage, otherHintTab } = state
  const otherHint = otherHintTab
    ? `Choose a model to set Effort and Fast for ${otherHintTab.name}.`
    : null

  return (
    <div
      data-testid="agent-model-selector-panel"
      className={cn('flex min-h-0 flex-col', !touch && 'w-80')}
    >
      <div className={cn('peer flex items-center gap-2', touch ? 'h-12 px-5' : 'h-10 px-3')}>
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
            state.setQuery(event.target.value)
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
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {view.kind === 'search' ? view.count : null}
          </span>
        ) : null}
      </div>
      <div className="h-px bg-border transition-colors duration-150 ease-out peer-focus-within:bg-ring" />
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
        key={state.listKey}
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
