import { motion, useReducedMotion } from 'framer-motion'
import { type KeyboardEvent, type ReactNode, useCallback, useRef } from 'react'
import { Check, MoreHorizontal, Search, Zap } from '@/components/icons'
import { BAND_FOCUS_CLASS, INNER_FIELD_FOCUS_CLASS } from '@/components/ui/panel-styles'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SessionConfigOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { flattenConfigOptionValues } from '../chat-input-bar-config'
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
import type { SelectorPanelProps } from './SelectorPanel'
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
  type CatalogModel,
  entryDisableReason,
  type FavoriteModel,
  type ModelCatalog,
  splitContextOption
} from './selector-model'
import { useRejectedOptionValues } from './use-option-values'
import { useSelectorPanelState } from './use-selector-panel-state'

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

/** A select option's value, or undefined when the agent sent none (or a non-string). */
const selectValue = (option: SessionConfigOption): string | undefined =>
  typeof option.currentValue === 'string' ? option.currentValue : undefined

type IsRejected = (optionId: string, value: string) => boolean
type TrySet = (optionId: string, value: string | boolean) => Promise<void>

/**
 * A select option's choices, labelled from the option data. A value the agent
 * rejected is dropped, or kept disabled while it is still the current one.
 */
function optionChoices(option: SessionConfigOption, isRejected?: IsRejected): OptionChoice[] {
  const current = selectValue(option)
  return flattenConfigOptionValues(option).flatMap(({ value, name, description }) => {
    const unavailable = isRejected?.(option.id, value) ?? false
    if (unavailable && value !== current) return []
    return [{ value, name, description: description ?? undefined, unavailable }]
  })
}

const ignore = (): void => {}

/**
 * The active model's session options: Thinking (the effort option), Context,
 * Fast mode. Each shows only when the agent sends that option, with value
 * labels from the option data. They sit in the active row's Edit flyout, or
 * in the footer when no active row is on screen.
 */
function editSections(
  props: SelectorPanelV2Props,
  context: SessionConfigOption | null,
  isRejected: IsRejected,
  trySet: TrySet
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
  const windows = context ? optionChoices(context, isRejected) : []
  if (context && windows.length > 0) {
    sections.push({
      kind: 'radio',
      id: 'context',
      label: 'Context',
      value: selectValue(context),
      choices: windows,
      onPick: (value) => void trySet(context.id, value).catch(ignore)
    })
  }
  const { onToggleFast } = props
  if (props.fastMode && onToggleFast) {
    sections.push({
      kind: 'toggle',
      id: 'fast',
      label: 'Fast mode',
      icon: <Zap size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />,
      checked: props.fastOn,
      onToggle: () => onToggleFast()
    })
  }
  return sections
}

/**
 * The footer's session option rows: the agent's other options, after the
 * active model's own ones when no active row holds them.
 */
function SessionOptions({
  sections,
  rest,
  isRejected,
  trySet,
  disabled,
  touch
}: {
  sections: ChoiceSection[]
  rest: SessionConfigOption[]
  isRejected: IsRejected
  trySet: TrySet
  disabled: boolean
  touch: boolean
}): React.JSX.Element | null {
  const ref = useRef<HTMLFieldSetElement>(null)
  const rows: ReactNode[] = sections.map((section) =>
    section.kind === 'toggle' ? (
      <OptionSwitchRow
        key={section.id}
        id={section.id}
        label={section.label}
        icon={section.icon}
        checked={section.checked}
        disabled={disabled}
        touch={touch}
        onToggle={section.onToggle}
      />
    ) : (
      <OptionRow
        key={section.id}
        id={section.id}
        label={section.label}
        value={section.value}
        choices={section.choices}
        disabled={disabled}
        touch={touch}
        onSelect={section.onPick}
      />
    )
  )
  for (const option of rest) {
    if (option.type === 'boolean') {
      rows.push(
        <OptionSwitchRow
          key={option.id}
          id={option.id}
          label={option.name}
          checked={option.currentValue === true}
          disabled={disabled}
          touch={touch}
          onToggle={(value) => trySet(option.id, value)}
        />
      )
      continue
    }
    const choices = optionChoices(option, isRejected)
    if (choices.length === 0) continue
    rows.push(
      <OptionRow
        key={option.id}
        id={option.id}
        label={option.name}
        value={selectValue(option)}
        choices={choices}
        disabled={disabled}
        touch={touch}
        onSelect={(value) => void trySet(option.id, value).catch(ignore)}
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
 * Model picker v2: the same state as `SelectorPanel` (one hook) in a denser
 * layout. Glyph tabs with an underline, a Favorites section, 28px rows, and
 * an Edit flyout on the active model for Thinking, Context and Fast mode.
 * Visual direction after volt (MIT, github.com/LeulAria/volt), on Termul
 * tokens.
 */
export function SelectorPanelV2(props: SelectorPanelV2Props): React.JSX.Element {
  const { source: sw, touch, disabled, modelValue } = props
  const reduced = useReducedMotion() ?? false
  const state = useSelectorPanelState(props, { reserveMoreTab: false, favorites: props.favorites })
  const { query, searching, showingMore, effectiveId, viewId, viewTab, tabs, view } = state
  const { effectiveCatalog, capabilities, nameOf, tabOf } = state
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const { isRejected, trySet } = useRejectedOptionValues(
    effectiveId,
    props.genericOptions,
    props.onSetConfig
  )
  const { context, rest } = splitContextOption(props.genericOptions)
  const edit = editSections(props, context, isRejected, trySet)
  // The Edit flyout hangs off the active model's row. With no such row on
  // screen (no model list, or a value outside it) the footer takes its rows.
  const activeShown =
    modelValue !== undefined &&
    (view.kind === 'effective'
      ? Boolean(view.catalog?.options.some((m) => m.value === modelValue))
      : view.kind === 'search' && view.own.some((m) => m.value === modelValue))

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
        onPick={() => state.pick(configId, catalog, model.value)}
      />
    ))

  const agentRow = (tab: AgentTab, key: string, onPick: () => void): React.JSX.Element => (
    <AgentRow
      key={key}
      tab={tab}
      badge={state.badgeOf(tab)}
      disabled={disabled || state.notSetUp(tab)}
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
            {rows(effectiveId, effectiveCatalog, view.own, modelValue, tabOf(effectiveId), true)}
            {view.others.map(({ configId, catalog, model }) =>
              rows(configId, catalog, [model], undefined, tabOf(configId), true)
            )}
            {view.agents.map((tab) =>
              agentRow(tab, `agent\0${tab.configId}`, () => {
                state.setQuery('')
                state.openAgent(tab)
              })
            )}
          </>
        )
      break
    case 'more':
      body = view.tabs.map((tab) => agentRow(tab, tab.configId, () => state.openAgent(tab)))
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
          {view.favorites.length > 0 ? (
            <>
              <SectionLabel>Favorites</SectionLabel>
              {view.favorites.map((favorite) =>
                rows(
                  favorite.configId,
                  favorite.catalog,
                  [favorite.model],
                  favorite.configId === effectiveId ? modelValue : undefined,
                  tabOf(favorite.configId),
                  true,
                  'favorite\0'
                )
              )}
              <SectionLabel>{viewTab?.name ?? 'Models'}</SectionLabel>
            </>
          ) : null}
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
        <div className="flex flex-col gap-1">
          <ListMessage title={view.title} detail={view.detail} />
          {view.retry ? (
            <button
              type="button"
              onClick={view.retry}
              className={cn(DENSE_ROW, denseRowSize(touch), 'justify-center')}
            >
              Try again
            </button>
          ) : null}
        </div>
      )
      break
    case 'loading':
      body = <ListMessage loading title={view.title} />
      break
  }

  const tabItems: TabItem[] = tabs.visible.map((tab) => ({
    key: tab.configId,
    label: tab.name,
    glyph: <TabGlyph tab={tab} />,
    selected: !showingMore && tab.configId === viewId,
    title: state.hasUpdate(tab) ? `${tab.name} · update available` : tab.name,
    onSelect: () => state.openAgent(tab)
  }))
  if (tabs.overflow.length > 0) {
    tabItems.push({
      key: 'more',
      label: 'More agents',
      glyph: <MoreHorizontal size={14} aria-hidden="true" />,
      selected: showingMore,
      title: 'More agents',
      onSelect: state.showMore
    })
  }
  const showTabs = !searching && tabItems.length > 1

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
  const otherHint = state.otherHintTab
    ? `Choose a model to set Thinking and Fast mode for ${state.otherHintTab.name}.`
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
          onChange={(event) => state.setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search models…"
          aria-label="Search models and agents"
          className={cn(
            `min-w-0 flex-1 bg-transparent text-foreground placeholder:text-muted-foreground ${INNER_FIELD_FOCUS_CLASS}`,
            touch ? 'text-base' : 'text-sm'
          )}
        />
        {view.kind === 'search' ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{view.count}</span>
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
        key={state.listKey}
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
      {!searching && state.contextUsage ? (
        <>
          <div className="h-px bg-border" />
          <ContextSummary usage={state.contextUsage} touch={touch} />
        </>
      ) : null}
      {state.ownFooter ? (
        <SessionOptions
          sections={activeShown ? [] : edit}
          rest={rest}
          isRejected={isRejected}
          trySet={trySet}
          disabled={disabled}
          touch={touch}
        />
      ) : null}
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
