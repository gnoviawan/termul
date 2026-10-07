import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentGlyph } from '@/components/chat/AgentGlyph'
import {
  SELECTOR_OPTION_ROW,
  SELECTOR_OPTION_ROW_DESKTOP,
  SELECTOR_OPTION_ROW_MOBILE,
  SELECTOR_SECTION_LABEL,
  SelectorModal,
  SelectorOptionLabel
} from '@/components/chat/AgentHeader'
import { AgentSwitchPicker } from '@/components/chat/AgentSwitchPicker'
import { ComposerPill } from '@/components/chat/ComposerPill'
import { isFastModeEnabled, oppositeFastModeValue } from '@/components/chat/chat-input-bar-config'
import { useOptimisticSelect } from '@/components/chat/use-optimistic-select'
import { ChevronLeft, ChevronRight, X } from '@/components/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { SessionConfigOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'

type Panel = 'effort' | 'model' | null

const PRESS = 'duration-150 ease-out enabled:active:scale-[0.96] motion-reduce:active:scale-100'

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
  onSetConfig: (configId: string, valueId: string) => void | Promise<void>
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
  onSetConfig,
  onSetModel
}: AgentModelSelectorProps): React.JSX.Element | null {
  const isMobile = useMobileWebShell()
  const reduced = useReducedMotion() ?? false
  const agent = useComposerAgentLabel(sessionId)
  const cancelAgentSwitch = useAcpStore((s) => s.cancelAgentSwitch)
  const [open, setOpen] = useState(false)
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

  const modelSelect = useOptimisticSelect(modelOption?.currentValue, selectModel)
  const effortSelect = useOptimisticSelect(thoughtLevel?.currentValue, selectEffort)
  const fastSelect = useOptimisticSelect(fastMode?.currentValue, selectFast)

  const modelName = modelOption?.options.find(
    (option) => option.value === modelSelect.displayValue
  )?.name
  const effortName = thoughtLevel?.options.find(
    (option) => option.value === effortSelect.displayValue
  )?.name
  const fastOn = fastMode ? isFastModeEnabled(fastMode, fastSelect.displayValue) : false
  const fastNext = fastMode ? oppositeFastModeValue(fastMode, fastSelect.displayValue) : null
  const show = Boolean(modelOption || thoughtLevel || fastMode || agent.present)

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
    if (flyout === 'effort' || flyout === 'model') {
      event.preventDefault()
      setPanel(flyout)
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
    <div className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5">
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
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-secondary',
        PRESS,
        panel === 'effort' && 'bg-secondary'
      )}
    >
      <span className="shrink-0">Effort</span>
      <span className="ml-auto truncate text-muted-foreground">
        {effortName ?? thoughtLevel.name}
      </span>
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
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
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-secondary',
        PRESS,
        panel === 'model' && 'bg-secondary'
      )}
    >
      <AgentGlyph
        templateId={agentTemplateId}
        icon={agentIcon}
        size={14}
        className="shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate">{modelName ?? modelOption.name}</span>
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  ) : null

  const effortList = thoughtLevel ? (
    <div ref={effortListRef} className="p-1">
      <div className={SELECTOR_SECTION_LABEL}>Effort</div>
      <div
        data-testid="effort-options"
        className="max-h-[180px] overflow-y-auto overscroll-contain pr-1"
      >
        {thoughtLevel.options.map((option) => {
          const selected = option.value === effortSelect.displayValue
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onKeyDown={onFlyoutKeyDown}
              onClick={() => chooseEffort(option.value)}
              className={cn(
                SELECTOR_OPTION_ROW,
                isMobile ? SELECTOR_OPTION_ROW_MOBILE : SELECTOR_OPTION_ROW_DESKTOP,
                PRESS,
                selected && 'bg-secondary'
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
          'mb-1 w-full rounded-md bg-background px-2 py-1.5 text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-foreground/20',
          isMobile ? 'text-base' : 'text-sm'
        )}
      />
      <div
        data-testid="config-chip-model-options"
        className="max-h-[180px] overflow-y-auto overscroll-contain pr-1"
      >
        {filteredModels.length > 0 ? (
          filteredModels.map((option) => {
            const selected = option.value === modelSelect.displayValue
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onKeyDown={onFlyoutKeyDown}
                onClick={() => chooseModel(option.value)}
                className={cn(
                  SELECTOR_OPTION_ROW,
                  isMobile ? SELECTOR_OPTION_ROW_MOBILE : SELECTOR_OPTION_ROW_DESKTOP,
                  PRESS,
                  selected && 'bg-secondary'
                )}
              >
                <AgentGlyph
                  templateId={agentTemplateId}
                  icon={agentIcon}
                  size={14}
                  className="mt-0.5 shrink-0 text-muted-foreground"
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

  const mainRows = (
    <div
      ref={mainRef}
      className={cn('p-1', !isMobile && (!modelOption && agent.present ? 'w-72' : 'w-56'))}
    >
      {fastRow}
      {effortRow}
      {modelRow}
      {!modelOption && providerMenu(false)}
    </div>
  )

  const desktopBody = (
    <div className="flex items-stretch">
      <AnimatePresence initial={false}>
        {panel === 'effort' && effortList && (
          <motion.div
            key="effort"
            initial={reduced ? { opacity: 0 } : { opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: -12 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="w-56 border-r border-border"
          >
            {effortList}
          </motion.div>
        )}
        {panel === 'model' && modelPane && (
          <motion.div
            key="model"
            initial={reduced ? { opacity: 0 } : { opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: -12 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="border-r border-border"
          >
            {modelPane}
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
        {panel === 'effort' ? 'Effort' : 'Model'}
      </button>
      {panel === 'effort' ? effortList : modelPane}
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
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 disabled:cursor-not-allowed disabled:opacity-60"
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
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        collisionPadding={8}
        onEscapeKeyDown={onEscapeKeyDown}
        className="w-auto max-w-[calc(100vw-1rem)] rounded-xl border-border p-0 text-popover-foreground shadow-md"
      >
        {desktopBody}
      </PopoverContent>
    </Popover>
  )

  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      {shell}
      {cancel}
    </span>
  )
}
