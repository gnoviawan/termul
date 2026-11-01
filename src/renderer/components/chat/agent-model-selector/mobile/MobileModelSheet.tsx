import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { Star } from '@/components/icons'
import {
  MobileSheetContent,
  SheetGroup,
  SheetRow,
  useSheetSubview
} from '@/components/ui/mobile-sheet'
import { SheetDescription } from '@/components/ui/sheet'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import {
  type FavoriteKey,
  type FavoritesStore,
  favoriteId,
  useFavoriteModels,
  useFavoritesStore
} from '../favorite-models'
import type { SelectorPanelProps } from '../SelectorPanel'
import {
  BusyBlock,
  Hint,
  InstallState,
  ListMessage,
  StatusActions,
  TabGlyph
} from '../SelectorRows'
import {
  type AgentTab,
  type CatalogModel,
  entryDisableReason,
  type ModelCatalog,
  rowAccessibleName,
  splitContextOption
} from '../selector-model'
import { editSections, restSections } from '../session-option-sections'
import { useRejectedOptionValues } from '../use-option-values'
import { useSelectorPanelState } from '../use-selector-panel-state'
import { AgentChips } from './MobileAgentChips'
import { ChoiceList, type ModeControl, OptionsCard, sheetOptions } from './MobileSheetOptions'
import { type CompactControl, UsageCard } from './MobileUsageCard'

/** A long list gets a search field; a short one is quicker to scan. */
const SEARCH_THRESHOLD = 12

export interface MobileModelSheetProps extends SelectorPanelProps {
  /** The chat; empty in the launcher, which has no usage to show. */
  sessionId: string
  open: boolean
  /** Keys the sub-view's overlay entry above the sheet's own. */
  overlayId: string
  mode: ModeControl | null
  compact: CompactControl | null
  favoritesStore?: FavoritesStore
  onCloseAutoFocus?: (event: Event) => void
}

function StarToggle({
  on,
  disabled,
  onToggle
}: {
  on: boolean
  disabled: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? 'Remove from favorites' : 'Add to favorites'}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex w-11 shrink-0 items-center justify-center transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed',
        on ? 'text-foreground' : 'text-muted-foreground/60'
      )}
    >
      <Star size={16} aria-hidden="true" className={cn(on && '[&_path]:fill-current')} />
    </button>
  )
}

/**
 * The phone's "Select model" sheet: agent chips, the viewed agent's models (with
 * Favorites first), then Effort, Mode, Fast and the other options, then usage.
 * State is `useSelectorPanelState`, as in the desktop panels.
 */
export function MobileModelSheet(props: MobileModelSheetProps): React.JSX.Element {
  const { source: sw, disabled, modelValue, escapeRef } = props
  const appStore = useFavoritesStore()
  const favoritesStore = props.favoritesStore ?? appStore
  const favorites = useFavoriteModels(favoritesStore)
  const state = useSelectorPanelState(props, {
    reserveMoreTab: false,
    stableTabCapacity: Number.POSITIVE_INFINITY,
    favorites
  })
  const { view, effectiveId, tabOf, nameOf } = state
  const sub = useSheetSubview<string>(props.overlayId, props.open)
  const { isRejected, trySet } = useRejectedOptionValues(
    effectiveId,
    props.genericOptions,
    props.onSetConfig
  )
  const { context, rest } = splitContextOption(props.genericOptions)
  const options = sheetOptions(
    editSections(props, context, isRejected, trySet),
    restSections(rest, isRejected, trySet),
    props.mode
  )
  const openOption = options.find((option) => option.id === sub.view)

  const starred = new Set(favorites.map(favoriteId))
  const toggleFavorite = (key: FavoriteKey): void => {
    const id = favoriteId(key)
    const on = !starred.has(id)
    favoritesStore.set(key, on).catch((error: unknown) => {
      toast.error('Could not update favorites.')
      void logFrontendError({
        level: 'warn',
        source: 'MobileModelSheet.favorites',
        message: `Failed to ${on ? 'add' : 'remove'} favorite ${id.replace('\0', '/')}: ${String(error)}`
      })
    })
  }

  const modelRows = (
    configId: string | null,
    catalog: ModelCatalog | null,
    models: readonly CatalogModel[],
    selectedValue: string | undefined,
    /** Rows from several agents: each shows and names its own agent. */
    mixed: boolean
  ): ReactNode =>
    models.map((model) => {
      const tab = tabOf(configId)
      const key = configId ? { configId, modelId: model.value } : null
      const agentName = mixed && configId !== effectiveId ? tab?.name : undefined
      return (
        <SheetRow
          key={`${configId}\0${model.value}`}
          icon={mixed && tab ? <TabGlyph tab={tab} /> : undefined}
          title={model.name.trim()}
          subtitle={model.description || undefined}
          aria-label={agentName ? rowAccessibleName({ name: model.name, agentName }) : undefined}
          accessory="check"
          selected={model.value === selectedValue}
          disabled={disabled}
          onSelect={() => state.pick(configId, catalog, model.value)}
          aside={
            key ? (
              <StarToggle
                on={starred.has(favoriteId(key))}
                disabled={disabled}
                onToggle={() => toggleFavorite(key)}
              />
            ) : undefined
          }
        />
      )
    })

  const agentRows = (tabs: readonly AgentTab[], onPick: (tab: AgentTab) => void): ReactNode =>
    tabs.map((tab) => (
      <SheetRow
        key={`agent\0${tab.configId}`}
        icon={<TabGlyph tab={tab} />}
        title={tab.name}
        value={state.badgeOf(tab) ?? undefined}
        disabled={disabled || state.notSetUp(tab)}
        onSelect={() => onPick(tab)}
      />
    ))

  let list: ReactNode
  let modelCount = 0
  switch (view.kind) {
    case 'search':
      list =
        view.count === 0 ? (
          <ListMessage title="No models or agents match." detail="Try another name." />
        ) : (
          <SheetGroup>
            {modelRows(effectiveId, state.effectiveCatalog, view.own, modelValue, true)}
            {view.others.map(({ configId, catalog, model }) =>
              modelRows(configId, catalog, [model], undefined, true)
            )}
            {agentRows(view.agents, (tab) => {
              state.setQuery('')
              state.openAgent(tab)
            })}
          </SheetGroup>
        )
      break
    case 'more':
      list = <SheetGroup>{agentRows(view.tabs, state.openAgent)}</SheetGroup>
      break
    case 'install':
      list = (
        <InstallState
          tab={view.tab}
          reason={entryDisableReason(view.entry)}
          installing={view.installing}
          installBlocked={view.installBlocked}
          touch
          onInstall={view.install}
        />
      )
      break
    case 'effective':
      modelCount = view.catalog?.options.length ?? 0
      list = view.catalog ? (
        <>
          {view.favorites.length > 0 ? (
            <SheetGroup label="Favorites">
              {view.favorites.map((favorite) =>
                modelRows(
                  favorite.configId,
                  favorite.catalog,
                  [favorite.model],
                  favorite.configId === effectiveId ? modelValue : undefined,
                  true
                )
              )}
            </SheetGroup>
          ) : null}
          <SheetGroup label={view.favorites.length > 0 ? nameOf(effectiveId) : undefined}>
            {modelRows(effectiveId, view.catalog, view.catalog.options, modelValue, false)}
          </SheetGroup>
          {view.stale?.error ? (
            <StatusActions
              title={`${view.stale.error.label}. These models are from the last session.`}
              detail={view.stale.error.detail}
              status={view.stale}
              touch
              compact
            />
          ) : null}
        </>
      ) : (
        <ListMessage
          title="This agent gives no model choice."
          detail={state.capabilities ?? undefined}
        />
      )
      break
    case 'current':
      modelCount = view.catalog?.options.length ?? 0
      list = (
        <>
          {view.catalog ? (
            <SheetGroup>
              {modelRows(state.viewId, view.catalog, view.catalog.options, undefined, false)}
            </SheetGroup>
          ) : (
            <ListMessage title={`${nameOf(state.viewId)} gives no model choice.`} />
          )}
          <Hint>{`Keeps ${nameOf(state.viewId)} and cancels the switch to ${nameOf(sw.armedConfigId)}.`}</Hint>
        </>
      )
      break
    case 'other':
      modelCount = view.catalog.options.length
      list = (
        <>
          <SheetGroup>
            {modelRows(state.viewId, view.catalog, view.catalog.options, undefined, false)}
          </SheetGroup>
          {view.confirming ? (
            <BusyBlock
              agentName={nameOf(sw.currentConfigId)}
              canCancel={sw.turnBusy}
              touch
              onWait={state.waitForTurn}
              onCancelAndSwitch={state.cancelAndSwitch}
            />
          ) : (
            <Hint>{`Switches to ${nameOf(state.viewId)} on the next send`}</Hint>
          )}
        </>
      )
      break
    case 'error':
      list = view.status ? (
        <StatusActions title={view.title} detail={view.detail} status={view.status} touch />
      ) : (
        <>
          <ListMessage title={view.title} detail={view.detail} />
          {view.retry ? (
            <SheetGroup>
              <SheetRow title="Try again" onSelect={view.retry} />
            </SheetGroup>
          ) : null}
        </>
      )
      break
    case 'loading':
      list = <ListMessage loading title={view.title} />
      break
  }

  const onEscapeKeyDown = (event: KeyboardEvent): void => {
    if (sub.view !== null) {
      sub.onEscapeKeyDown(event)
      return
    }
    if (escapeRef.current?.()) event.preventDefault()
  }

  const allTabs = [...state.tabs.visible, ...state.tabs.overflow]
  const subOption = openOption?.kind === 'radio' ? openOption : null
  return (
    <MobileSheetContent
      title={subOption ? subOption.label : 'Select model'}
      onBack={subOption ? sub.back : undefined}
      view={subOption ? subOption.id : null}
      toolbar={
        subOption || state.searching ? null : (
          <AgentChips
            tabs={allTabs}
            viewId={state.viewId}
            badgeOf={state.badgeOf}
            disabled={disabled}
            onOpen={state.openAgent}
          />
        )
      }
      // Focus the sheet, not its first field. A focused search field raises the
      // keyboard, and the browser raises it again when the tab comes back.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        ;(event.currentTarget as HTMLElement).focus()
      }}
      onEscapeKeyDown={onEscapeKeyDown}
      onCloseAutoFocus={props.onCloseAutoFocus}
      data-testid="agent-model-selector-panel"
      data-variant="mobile"
    >
      <SheetDescription className="sr-only">
        Choose a model, an agent, and its options.
      </SheetDescription>
      {subOption ? (
        <ChoiceList option={subOption} disabled={disabled} onDone={sub.back} />
      ) : (
        <>
          {state.searching || modelCount > SEARCH_THRESHOLD ? (
            <input
              type="search"
              value={state.query}
              onChange={(event) => state.setQuery(event.target.value)}
              placeholder="Search models…"
              aria-label="Search models and agents"
              className="h-11 w-full shrink-0 rounded-xl bg-foreground/[0.05] px-4 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          ) : null}
          {list}
          {state.ownFooter && !state.searching ? (
            <OptionsCard options={options} disabled={disabled} onOpen={sub.open} />
          ) : null}
          {state.otherHintTab ? (
            <p className="px-3 text-xs text-muted-foreground">
              {`Choose a model to set the options for ${state.otherHintTab.name}.`}
            </p>
          ) : null}
          {state.searching ? null : (
            <UsageCard
              sessionId={props.sessionId}
              usage={state.contextUsage}
              compact={props.compact}
            />
          )}
        </>
      )}
    </MobileSheetContent>
  )
}
