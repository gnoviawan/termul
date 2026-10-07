import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentGlyph } from '@/components/chat/AgentGlyph'
import {
  SELECTOR_OPTION_ROW,
  SELECTOR_OPTION_ROW_DESKTOP,
  SELECTOR_OPTION_ROW_MOBILE,
  SELECTOR_OPTION_SELECTED,
  SELECTOR_SECTION_LABEL,
  SelectorModal,
  SelectorOptionLabel
} from '@/components/chat/AgentHeader'
import { AgentSwitchPicker } from '@/components/chat/AgentSwitchPicker'
import { ComposerPill } from '@/components/chat/ComposerPill'
import { isFastModeEnabled, oppositeFastModeValue } from '@/components/chat/chat-input-bar-config'
import { useOptimisticSelect } from '@/components/chat/use-optimistic-select'

function selectValue(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}
import { ChevronLeft, ChevronRight, X } from '@/components/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { SessionConfigOption, SessionUsage } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import {
  conversationUsageMetrics,
  formatReportedCost,
  formatTokenCount,
  isMeaningfulReportedCost,
  shouldShowSessionUsage
} from '../context-usage-utils'

type Panel = 'effort' | 'model' | 'context' | `config:${string}` | null

const PRESS = 'duration-150 ease-out enabled:active:scale-[0.96] motion-reduce:active:scale-100'
/** Visible on `bg-popover`: secondary matches that surface in the dark theme. */
const MENU_ROW =
  'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring enabled:active:scale-[0.96] motion-reduce:active:scale-100'
const MENU_ACTIVE = 'bg-foreground/10'
const MENU_MUTED =
  'text-muted-foreground transition-colors duration-150 group-hover:text-foreground group-focus-visible:text-foreground'

interface AgentModelSelectorProps {
  sessionId: string
  disabled: boolean
  busy: boolean
  modelOption: SessionConfigOption | null
  modelSource: 'config' | 'models' | null
  thoughtLevel: SessionConfigOption | null
  fastMode: SessionConfigOption | null
  agentTemplateId: string | null
  agentIcon: string | null
  /** Config options that are not model, effort, Fast, or mode. */
  genericOptions: SessionConfigOption[]
  usage: SessionUsage | null
  messages: ReadonlyArray<{ role: string }>
  onSetConfig: (configId: string, valueId: string | boolean) => void | Promise<void>
  onSetModel: (modelId: string) => void | Promise<void>
}

/**
 * Current-agent label for the combined pill. Matches the standalone switch
 * chip's accessible name so a closed session still announces the agent.
 */
function useComposerAgentLabel(sessionId: string): {
  present: boolean
  visible: string
  aria: string
  armedName: string | null
} {
  const agentConfigs = useAcpStore((s) => s.agentConfigs ?? [])
  const currentConfigId = useAcpStore((s) => {
    const session = s.sessions?.[sessionId]
    if (session?.agentId) {
      for (const [key, id] of Object.entries(s.configToLiveAgent ?? {})) {
        if (id === session.agentId) return key.split('\0')[0]
      }
    }
    return s.sessionIndex?.find((entry) => entry.id === sessionId)?.agentConfigId ?? null
  })
  const armedName = useAcpStore((s) => {
    const to = s.sessions?.[sessionId]?.switching?.toConfigId
    return to ? (s.agentConfigs?.find((config) => config.id === to)?.name ?? to) : null
  })
  const sessionAgentId = useAcpStore((s) => s.sessions?.[sessionId]?.agentId ?? '')
  const currentName = agentConfigs.find((config) => config.id === currentConfigId)?.name
  const present = Boolean(sessionAgentId || currentConfigId)
  const visible = armedName ? `→ ${armedName}` : (currentName ?? 'Agent')
  const aria = armedName
    ? `Switch to ${armedName} on next send. Cancel to keep ${currentName ?? 'the current agent'}`
    : `Switch agent. Currently ${currentName ?? 'the current agent'}`
  return { present, visible, aria, armedName }
}

export function AgentModelSelector({
  sessionId,
  disabled,
  busy,
  modelOption,
  modelSource,
  thoughtLevel,
  fastMode,
  agentTemplateId,
  agentIcon,
  genericOptions,
  usage,
  messages,
  onSetConfig,
  onSetModel
}: AgentModelSelectorProps): React.JSX.Element | null {
  const isMobile = useMobileWebShell()
  const reduced = useReducedMotion() ?? false
  const agent = useComposerAgentLabel(sessionId)
  const cancelAgentSwitch = useAcpStore((s) => s.cancelAgentSwitch)
  const [open, setOpen] = useState(false)
  const [shellMounted, setShellMounted] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [modelQuery, setModelQuery] = useState('')
  const modelSearchRef = useRef<HTMLInputElement>(null)
  const effortListRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)

  const selectModel = useCallback(
    (valueId: string) => {
      if (!modelOption) return
      if (modelSource === 'models') return onSetModel(valueId)
      return onSetConfig(modelOption.id, valueId)
    },
    [modelOption, modelSource, onSetConfig, onSetModel]
  )
  const selectEffort = useCallback(
    (valueId: string) => {
      if (!thoughtLevel) return
      return onSetConfig(thoughtLevel.id, valueId)
    },
    [onSetConfig, thoughtLevel]
  )
  const selectFast = useCallback(
    (valueId: string) => {
      if (!fastMode) return
      return onSetConfig(fastMode.id, valueId)
    },
    [fastMode, onSetConfig]
  )

  const modelSelect = useOptimisticSelect(selectValue(modelOption?.currentValue), selectModel)
  const effortSelect = useOptimisticSelect(selectValue(thoughtLevel?.currentValue), selectEffort)
  const fastSelect = useOptimisticSelect(selectValue(fastMode?.currentValue), selectFast)

  const modelName = (modelOption?.options ?? []).find(
    (option) => option.value === modelSelect.displayValue
  )?.name
  const effortName = (thoughtLevel?.options ?? []).find(
    (option) => option.value === effortSelect.displayValue
  )?.name
  const fastOn = fastMode ? isFastModeEnabled(fastMode, fastSelect.displayValue) : false
  const fastNext = fastMode ? oppositeFastModeValue(fastMode, fastSelect.displayValue) : null
  const contextSizeLabel =
    usage && Number.isFinite(usage.size) && usage.size > 0 ? formatTokenCount(usage.size) : null
  const visibleUsage = shouldShowSessionUsage(usage, messages)
  const usageMetrics = visibleUsage ? conversationUsageMetrics(visibleUsage) : null
  const show = Boolean(
    modelOption ||
      thoughtLevel ||
      fastMode ||
      agent.present ||
      genericOptions.length > 0 ||
      contextSizeLabel
  )

  if (open && !shellMounted) setShellMounted(true)

  const closeAll = useCallback(() => {
    setOpen(false)
    setPanel(null)
    setModelQuery('')
  }, [])

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    if (!next) {
      setPanel(null)
      setModelQuery('')
    }
  }, [])

  useEffect(() => {
    if (panel === 'model') modelSearchRef.current?.focus()
    if (panel === 'effort') {
      effortListRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
  }, [panel])

  if (!show) return null

  const normalizedQuery = modelQuery.trim().toLowerCase()
  const filteredModels = (modelOption?.options ?? []).filter((option) => {
    if (!normalizedQuery) return true
    return [option.name, option.value, option.description ?? '']
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery)
  })

  const ariaParts = [modelName, effortName, agent.present ? agent.aria : null].filter(
    (part): part is string => Boolean(part)
  )
  const pillAria = ariaParts.join('. ') || 'Model and effort'
  const pending = modelSelect.pending || effortSelect.pending || fastSelect.pending
  const onEscapeKeyDown = (event: KeyboardEvent): void => {
    if (!panel) return
    event.preventDefault()
    setPanel(null)
  }

  const onMainKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const root = mainRef.current
    if (!root) return
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-selector-row]'))
    const current = (event.target as HTMLElement).closest<HTMLElement>('[data-selector-row]')
    const index = current ? rows.indexOf(current) : -1
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) return
      event.preventDefault()
      const nextIndex =
        event.key === 'ArrowDown'
          ? (Math.max(index, 0) + 1) % rows.length
          : (index <= 0 ? rows.length : index) - 1
      rows[nextIndex]?.focus()
      return
    }
    if (event.key !== 'ArrowRight') return
    const flyout = current?.dataset.flyout
    if (
      flyout === 'effort' ||
      flyout === 'model' ||
      flyout === 'context' ||
      flyout?.startsWith('config:')
    ) {
      event.preventDefault()
      setPanel(flyout as Panel)
    }
  }

  const onFlyoutKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'ArrowLeft') return
    const target = event.target as HTMLInputElement
    if (target.tagName === 'INPUT' && (target.selectionStart ?? 0) !== 0) return
    event.preventDefault()
    const which = panel
    setPanel(null)
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-flyout="${which}"]`)?.focus()
    })
  }

  const chooseModel = (valueId: string): void => {
    setModelQuery('')
    setPanel(null)
    modelSelect.select(valueId)
  }

  const chooseEffort = (valueId: string): void => {
    setPanel(null)
    effortSelect.select(valueId)
  }

  const fastRow = fastMode ? (
    <div className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-[background-color] duration-150 ease-out hover:bg-foreground/10">
      <span className="text-sm text-foreground">Fast</span>
      <Switch
        checked={fastOn}
        disabled={disabled || !fastNext}
        aria-label={fastMode.name}
        data-selector-row=""
        onKeyDown={onMainKeyDown}
        onCheckedChange={() => {
          if (fastNext) fastSelect.select(fastNext)
        }}
      />
    </div>
  ) : null

  const effortRow = thoughtLevel ? (
    <button
      type="button"
      data-selector-row=""
      data-flyout="effort"
      aria-expanded={panel === 'effort'}
      aria-label={`Effort, ${effortName ?? thoughtLevel.name}`}
      disabled={disabled}
      onKeyDown={onMainKeyDown}
      onClick={() => setPanel((current) => (current === 'effort' ? null : 'effort'))}
      className={cn(MENU_ROW, panel === 'effort' && MENU_ACTIVE)}
    >
      <span className="shrink-0">Effort</span>
      <span className={cn('ml-auto truncate', MENU_MUTED)}>{effortName ?? thoughtLevel.name}</span>
      <ChevronRight size={14} className={cn('shrink-0', MENU_MUTED)} aria-hidden="true" />
    </button>
  ) : null

  const modelRow = modelOption ? (
    <button
      type="button"
      data-selector-row=""
      data-flyout="model"
      aria-expanded={panel === 'model'}
      aria-label={`Model, ${modelName ?? modelOption.name}`}
      disabled={disabled}
      onKeyDown={onMainKeyDown}
      onClick={() => setPanel((current) => (current === 'model' ? null : 'model'))}
      className={cn(MENU_ROW, panel === 'model' && MENU_ACTIVE)}
    >
      <AgentGlyph
        templateId={agentTemplateId}
        icon={agentIcon}
        size={14}
        className={cn('shrink-0', MENU_MUTED)}
      />
      <span className="min-w-0 flex-1 truncate">{modelName ?? modelOption.name}</span>
      <ChevronRight size={14} className={cn('shrink-0', MENU_MUTED)} aria-hidden="true" />
    </button>
  ) : null

  const effortList = thoughtLevel ? (
    <div ref={effortListRef} className="p-1">
      <div className={SELECTOR_SECTION_LABEL}>Effort</div>
      <div
        data-testid="effort-options"
        className="max-h-[180px] overflow-y-auto overscroll-contain pr-1"
      >
        {(thoughtLevel.options ?? []).map((option) => {
          if (!option.value) return null
          const selected = option.value === effortSelect.displayValue
          const value = option.value
          return (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              onKeyDown={onFlyoutKeyDown}
              onClick={() => chooseEffort(value)}
              className={cn(
                SELECTOR_OPTION_ROW,
                isMobile ? SELECTOR_OPTION_ROW_MOBILE : SELECTOR_OPTION_ROW_DESKTOP,
                selected && SELECTOR_OPTION_SELECTED
              )}
            >
              <SelectorOptionLabel
                name={option.name}
                description={option.description}
                selected={selected}
              />
            </button>
          )
        })}
      </div>
    </div>
  ) : null

  const modelList = modelOption ? (
    <div className={cn('p-1', !isMobile && 'w-56')}>
      <input
        ref={modelSearchRef}
        value={modelQuery}
        onChange={(event) => setModelQuery(event.target.value)}
        placeholder="Search models…"
        aria-label="Search models"
        onKeyDown={onFlyoutKeyDown}
        className={cn(
          'mb-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-foreground outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-muted-foreground hover:border-foreground/30 focus:border-foreground/40 focus:ring-1 focus:ring-ring',
          isMobile ? 'text-base' : 'text-sm'
        )}
      />
      <div
        data-testid="config-chip-model-options"
        className="max-h-64 overflow-y-auto overscroll-contain pb-1 pr-1"
      >
        {filteredModels.length > 0 ? (
          filteredModels.map((option) => {
            if (!option.value) return null
            const selected = option.value === modelSelect.displayValue
            const value = option.value
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onKeyDown={onFlyoutKeyDown}
                onClick={() => chooseModel(value)}
                className={cn(
                  SELECTOR_OPTION_ROW,
                  isMobile ? SELECTOR_OPTION_ROW_MOBILE : SELECTOR_OPTION_ROW_DESKTOP,
                  selected && SELECTOR_OPTION_SELECTED
                )}
              >
                <AgentGlyph
                  templateId={agentTemplateId}
                  icon={agentIcon}
                  size={14}
                  className={cn('mt-0.5 shrink-0', MENU_MUTED)}
                />
                <SelectorOptionLabel
                  name={option.name}
                  description={option.description}
                  selected={selected}
                />
              </button>
            )
          })
        ) : (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No models match. Try another name.
          </div>
        )}
      </div>
    </div>
  ) : null

  const providerMenu = (rail: boolean): React.JSX.Element | null =>
    agent.present ? (
      <div
        className={cn(
          'min-w-0 p-1',
          rail && !isMobile && 'w-60 border-r border-border',
          rail && isMobile && 'border-b border-border'
        )}
      >
        <div className={SELECTOR_SECTION_LABEL}>Provider</div>
        <AgentSwitchPicker
          embedded
          sessionId={sessionId}
          busy={busy}
          disabled={disabled}
          onClose={closeAll}
        />
      </div>
    ) : null

  const modelPane =
    panel === 'model' ? (
      <div className={cn(!isMobile && 'flex items-stretch')}>
        {providerMenu(true)}
        {modelList}
      </div>
    ) : null

  const contextFlyout = contextSizeLabel ? (
    <div className="w-56 space-y-2 p-3 text-xs">
      <div className={SELECTOR_SECTION_LABEL}>Context</div>
      <div className="space-y-1 px-2 tabular-nums">
        <p className="font-medium text-foreground">Context window</p>
        <p className="text-muted-foreground">{contextSizeLabel}</p>
        {usageMetrics ? (
          <>
            <p className="text-muted-foreground">
              {Math.round(usageMetrics.percent)}% conversation used
            </p>
            <p className="text-muted-foreground">
              {formatTokenCount(usageMetrics.conversationUsed)} /{' '}
              {formatTokenCount(usageMetrics.conversationSize)} tokens
            </p>
            <p className="text-muted-foreground">
              {formatTokenCount(usageMetrics.remaining)} remaining
            </p>
          </>
        ) : null}
      </div>
      {visibleUsage && isMeaningfulReportedCost(visibleUsage.cost) && visibleUsage.cost ? (
        <div className="space-y-0.5 border-t border-border/60 px-2 pt-2">
          <p className="text-muted-foreground">Reported cost</p>
          <p className="font-medium tabular-nums text-foreground">
            {formatReportedCost(visibleUsage.cost.amount, visibleUsage.cost.currency)}
          </p>
        </div>
      ) : null}
    </div>
  ) : null

  const openConfig = panel?.startsWith('config:')
    ? (genericOptions.find((option) => `config:${option.id}` === panel) ?? null)
    : null
  const configFlyout = openConfig ? (
    <div className="w-56 p-1">
      <div className={SELECTOR_SECTION_LABEL}>{openConfig.name}</div>
      <div className="max-h-64 overflow-y-auto overscroll-contain pb-1 pr-1">
        {(openConfig.options ?? []).map((entry) => {
          const selected = entry.value === openConfig.currentValue
          return (
            <button
              key={entry.value}
              type="button"
              aria-pressed={selected}
              onKeyDown={onFlyoutKeyDown}
              onClick={() => {
                if (!entry.value) return
                setPanel(null)
                void onSetConfig(openConfig.id, entry.value)
              }}
              className={cn(
                SELECTOR_OPTION_ROW,
                isMobile ? SELECTOR_OPTION_ROW_MOBILE : SELECTOR_OPTION_ROW_DESKTOP,
                selected && SELECTOR_OPTION_SELECTED
              )}
            >
              <SelectorOptionLabel
                name={entry.name}
                description={entry.description}
                selected={selected}
              />
            </button>
          )
        })}
      </div>
    </div>
  ) : null

  const mainRows = (
    <div
      ref={mainRef}
      className={cn('p-1', !isMobile && (!modelOption && agent.present ? 'w-72' : 'w-56'))}
    >
      {fastRow}
      {effortRow}
      {modelRow}
      {contextSizeLabel ? (
        <button
          type="button"
          data-selector-row=""
          data-flyout="context"
          aria-expanded={panel === 'context'}
          aria-label={`Context, ${contextSizeLabel}`}
          disabled={disabled}
          onKeyDown={onMainKeyDown}
          onClick={() => setPanel((current) => (current === 'context' ? null : 'context'))}
          className={cn(MENU_ROW, panel === 'context' && MENU_ACTIVE)}
        >
          <span className="shrink-0">Context</span>
          <span className={cn('ml-auto truncate', MENU_MUTED)}>{contextSizeLabel}</span>
          <ChevronRight size={14} className={cn('shrink-0', MENU_MUTED)} aria-hidden="true" />
        </button>
      ) : null}
      {genericOptions.map((option) => {
        if (option.type === 'boolean') {
          const on = option.currentValue === true
          return (
            <div
              key={option.id}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-[background-color] duration-150 ease-out hover:bg-foreground/10"
            >
              <span className="text-sm text-foreground">{option.name}</span>
              <Switch
                checked={on}
                disabled={disabled}
                aria-label={option.name}
                data-selector-row=""
                onKeyDown={onMainKeyDown}
                onCheckedChange={(checked) => {
                  void onSetConfig(option.id, checked)
                }}
              />
            </div>
          )
        }
        const current = (option.options ?? []).find((entry) => entry.value === option.currentValue)
        const flyoutId = `config:${option.id}` as const
        return (
          <button
            key={option.id}
            type="button"
            data-selector-row=""
            data-flyout={flyoutId}
            aria-expanded={panel === flyoutId}
            aria-label={`${option.name}, ${current?.name ?? option.name}`}
            disabled={disabled}
            onKeyDown={onMainKeyDown}
            onClick={() => setPanel((value) => (value === flyoutId ? null : flyoutId))}
            className={cn(MENU_ROW, panel === flyoutId && MENU_ACTIVE)}
          >
            <span className="shrink-0 truncate">{option.name}</span>
            <span className={cn('ml-auto truncate', MENU_MUTED)}>
              {current?.name ?? option.name}
            </span>
            <ChevronRight size={14} className={cn('shrink-0', MENU_MUTED)} aria-hidden="true" />
          </button>
        )
      })}
      {!modelOption && providerMenu(false)}
    </div>
  )

  const desktopBody = (
    <div className="flex items-stretch">
      <AnimatePresence mode="wait" initial={false}>
        {panel && (
          <motion.div
            key={panel}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="border-r border-border"
          >
            {panel === 'effort'
              ? effortList
              : panel === 'model'
                ? modelPane
                : panel === 'context'
                  ? contextFlyout
                  : configFlyout}
          </motion.div>
        )}
      </AnimatePresence>
      {mainRows}
    </div>
  )

  const mobileBody = panel ? (
    <div>
      <button
        type="button"
        aria-label="Back"
        onClick={() => setPanel(null)}
        className={cn('flex items-center gap-1 px-2 py-1.5 text-sm text-foreground', PRESS)}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        {panel === 'effort'
          ? 'Effort'
          : panel === 'model'
            ? 'Model'
            : panel === 'context'
              ? 'Context'
              : (openConfig?.name ?? 'Option')}
      </button>
      {panel === 'effort'
        ? effortList
        : panel === 'model'
          ? modelPane
          : panel === 'context'
            ? contextFlyout
            : configFlyout}
    </div>
  ) : (
    mainRows
  )

  const trigger = (
    <ComposerPill
      disabled={disabled}
      pending={pending}
      chevron
      chevronDirection="up"
      aria-label={pillAria}
      data-testid="agent-model-selector-trigger"
      className={cn('max-w-[240px]', PRESS, isMobile && 'min-h-11 py-2')}
    >
      <AgentGlyph
        templateId={agentTemplateId}
        icon={agentIcon}
        size={13}
        className="shrink-0 text-muted-foreground"
      />
      {modelName ? (
        <span className="truncate">{modelName}</span>
      ) : (
        <span className="truncate">{agent.present ? agent.visible : (effortName ?? 'Fast')}</span>
      )}
      {modelName && effortName ? <span className="shrink-0">{effortName}</span> : null}
    </ComposerPill>
  )

  const cancel = agent.armedName ? (
    <button
      type="button"
      disabled={disabled}
      aria-label="Cancel agent switch"
      title="Cancel the armed switch — the next send stays with the current agent"
      data-testid="agent-switch-cancel"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-[background-color,color] duration-150 ease-out hover:bg-foreground/10 hover:text-foreground focus-visible:bg-foreground/10 focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      onClick={() => cancelAgentSwitch(sessionId)}
    >
      <X size={10} aria-hidden="true" />
    </button>
  ) : null

  const shell = isMobile ? (
    <SelectorModal
      open={open}
      onOpenChange={handleOpenChange}
      title={panel === 'effort' ? 'Effort' : panel === 'model' ? 'Model' : 'Model and effort'}
      trigger={trigger}
      disabled={disabled}
      onEscapeKeyDown={onEscapeKeyDown}
    >
      {mobileBody}
    </SelectorModal>
  ) : (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      {shellMounted ? (
        <PopoverContent
          forceMount
          align="end"
          side="top"
          sideOffset={12}
          collisionPadding={12}
          onEscapeKeyDown={onEscapeKeyDown}
          className="termul-popover-transition z-[100] w-auto max-w-[calc(100vw-1rem)] overflow-visible rounded-xl border-border p-0 text-popover-foreground shadow-md data-[state=closed]:animate-none data-[state=open]:animate-none"
        >
          <motion.div
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
            animate={
              open ? { opacity: 1, y: 0 } : reduced ? { opacity: 0, y: 0 } : { opacity: 0, y: 12 }
            }
            transition={
              open
                ? { duration: reduced ? 0.15 : 0.3, ease: 'easeOut' }
                : { duration: 0.15, ease: 'easeOut' }
            }
            onAnimationComplete={() => {
              if (!open) setShellMounted(false)
            }}
            className={cn(!open && 'pointer-events-none')}
          >
            {desktopBody}
          </motion.div>
        </PopoverContent>
      ) : null}
    </Popover>
  )

  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      {shell}
      {cancel}
    </span>
  )
}
