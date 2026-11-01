import { useCallback, useId, useRef, useState } from 'react'
import { AgentGlyph } from '@/components/chat/AgentGlyph'
import { ComposerPill } from '@/components/chat/ComposerPill'
import {
  flattenConfigOptionValues,
  isFastModeEnabled,
  oppositeFastModeValue,
  storedConfigValue,
  wireConfigValue
} from '@/components/chat/chat-input-bar-config'
import { useOptimisticSelect } from '@/components/chat/use-optimistic-select'
import { X } from '@/components/icons'
import { AnimatedMenuContent } from '@/components/ui/animated-menu-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetTrigger } from '@/components/ui/sheet'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { SessionConfigOption, SessionModeState, SessionUsage } from '@/lib/acp-api'
import { isModelPickerV2Enabled } from '@/lib/model-picker-flag'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { shouldShowSessionUsage } from '../context-usage-utils'
import { MobileModelPill } from './mobile/MobileModelPill'
import { MobileModelSheet } from './mobile/MobileModelSheet'
import type { ModeControl } from './mobile/MobileSheetOptions'
import type { CompactControl } from './mobile/MobileUsageCard'

/** What only the phone sheet uses: the modes, Compact, and whose Claude account to show. */
export interface PhoneSelectorControls {
  modes: SessionModeState | null
  onSetMode: (modeId: string) => void | Promise<void>
  /** The context ring's Compact; the launcher has no context to compact. */
  compact: CompactControl | null
  /** Launcher: the project whose Claude account the sheet shows (a chat reads its own). */
  claudeProjectId?: string | null
}

import type { SelectorPanelProps } from './SelectorPanel'
import { SelectorPanel } from './SelectorPanel'
import { SelectorPanelV2, type SelectorPanelV2Props } from './SelectorPanelV2'
import { type SelectorSource, useSessionSelectorSource } from './selector-source'
import { useCurrentAgentConfigId } from './use-agent-switch'

const PRESS = 'duration-150 ease-out enabled:active:scale-[0.96] motion-reduce:active:scale-100'

const NO_MESSAGES: ReadonlyArray<{ role: string }> = []

const NO_MODE_SET = (): void => {}

/** Booleans make `currentValue` non-string; the pill labels want strings. */
function selectValue(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The launcher's selector: no session yet, so it brings its own source. */
export interface DraftSelector {
  source: SelectorSource
  agentName: string | null
}

interface AgentModelSelectorProps {
  /** The chat session. Unused when `draft` is set. */
  sessionId?: string
  /** Launcher: a draft source instead of a live session. */
  draft?: DraftSelector
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
  /** Session usage for the context summary (chat only; the launcher omits it). */
  usage?: SessionUsage | null
  messages?: ReadonlyArray<{ role: string }>
  onSetConfig: (configId: string, valueId: string | boolean) => void | Promise<void>
  onSetModel: (modelId: string) => void | Promise<void>
  /**
   * Optional takeover of the close focus pass (Radix `onCloseAutoFocus`). The
   * launcher uses it to move the caret into the composer only after this
   * menu has fully closed — focusing earlier dismisses the popover.
   */
  onCloseAutoFocus?: (event: Event) => void
  phone?: PhoneSelectorControls
  /**
   * Design canvas only: always show the v2 panel, with these v2-only props
   * (agent rail, favorites). The app leaves it unset and follows the flag.
   */
  v2PanelProps?: Partial<Omit<SelectorPanelV2Props, keyof SelectorPanelProps>>
}

/**
 * Current-agent label for the pill. Matches the old switch chip's accessible
 * name so a closed session still announces the agent.
 */
function useComposerAgentLabel(sessionId: string): {
  present: boolean
  name: string
  aria: string
  armedName: string | null
} {
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const currentConfigId = useCurrentAgentConfigId(sessionId)
  const armedName = useAcpStore((s) => {
    const to = s.sessions?.[sessionId]?.switching?.toConfigId
    return to ? (s.agentConfigs?.find((config) => config.id === to)?.name ?? to) : null
  })
  const sessionAgentId = useAcpStore((s) => s.sessions?.[sessionId]?.agentId ?? '')
  const currentName = agentConfigs?.find((config) => config.id === currentConfigId)?.name
  const present = Boolean(sessionAgentId || currentConfigId)
  const aria = armedName
    ? `Switch to ${armedName} on next send. Cancel to keep ${currentName ?? 'the current agent'}`
    : `Switch agent. Currently ${currentName ?? 'the current agent'}`
  return { present, name: currentName ?? 'Agent', aria, armedName }
}

/**
 * The composer's model, effort, and agent selector. Desktop: a 320px popover
 * above the pill. Mobile web: a bottom sheet with 44px targets. Both render
 * the same `SelectorPanel`.
 */
export function AgentModelSelector({
  sessionId = '',
  draft,
  disabled,
  modelOption,
  modelSource,
  usage = null,
  messages = NO_MESSAGES,
  thoughtLevel,
  fastMode,
  agentTemplateId,
  agentIcon,
  genericOptions,
  onSetConfig,
  onSetModel,
  onCloseAutoFocus,
  phone,
  v2PanelProps
}: AgentModelSelectorProps): React.JSX.Element | null {
  const isMobile = useMobileWebShell()
  const sessionAgent = useComposerAgentLabel(sessionId)
  const sessionSource = useSessionSelectorSource(sessionId)
  const capabilities = useAcpStore((s) =>
    draft ? null : (s.agents?.[s.sessions?.[sessionId]?.agentId ?? '']?.capabilities ?? null)
  )
  const source = draft?.source ?? sessionSource
  const agent = draft
    ? {
        present: Boolean(draft.source.currentConfigId),
        name: draft.agentName ?? 'Agent',
        aria: `Agent and model. Currently ${draft.agentName ?? 'no agent'}`,
        armedName: null
      }
    : sessionAgent
  const modelStatus = source.modelStatus
  const cancelAgentSwitch = useAcpStore((s) => s.cancelAgentSwitch)
  const [open, setOpen] = useState(false)
  // A fresh panel (empty search, the chat's own agent tab) per opening.
  const [generation, setGeneration] = useState(0)
  const escapeRef = useRef<(() => boolean) | null>(null)

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
      const wireValue = wireConfigValue(fastMode, valueId)
      if (wireValue === null) return
      return onSetConfig(fastMode.id, wireValue)
    },
    [fastMode, onSetConfig]
  )

  const modelSelect = useOptimisticSelect(selectValue(modelOption?.currentValue), selectModel)
  const effortSelect = useOptimisticSelect(selectValue(thoughtLevel?.currentValue), selectEffort)
  const fastSelect = useOptimisticSelect(
    fastMode ? (storedConfigValue(fastMode) ?? undefined) : undefined,
    selectFast
  )
  const modes = phone?.modes ?? null
  const modeSelect = useOptimisticSelect(modes?.currentModeId, phone?.onSetMode ?? NO_MODE_SET)

  const modelName = modelOption
    ? flattenConfigOptionValues(modelOption).find(
        (option) => option.value === modelSelect.displayValue
      )?.name
    : undefined
  const effortName = thoughtLevel
    ? flattenConfigOptionValues(thoughtLevel).find(
        (option) => option.value === effortSelect.displayValue
      )?.name
    : undefined
  const fastOn = fastMode ? isFastModeEnabled(fastMode, fastSelect.displayValue) : false
  const fastNext = fastMode ? oppositeFastModeValue(fastMode, fastSelect.displayValue) : null
  const visibleUsage = shouldShowSessionUsage(usage, messages)
  const show = Boolean(
    modelOption ||
      thoughtLevel ||
      fastMode ||
      agent.present ||
      genericOptions.length > 0 ||
      visibleUsage
  )

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) setGeneration((n) => n + 1)
    setOpen(next)
  }, [])
  const close = useCallback(() => setOpen(false), [])
  // The mobile sheet is an overlay like any other: system back closes it (and
  // its own X / scrim / Esc close consumes the history sentinel). The desktop
  // popover is inert here.
  const overlayId = `agent-model-selector:${useId()}`
  useOverlayRegistration(overlayId, open && isMobile, close, { mobileShellOnly: true })
  const onEscapeKeyDown = (event: KeyboardEvent): void => {
    if (escapeRef.current?.()) event.preventDefault()
  }

  if (!show) return null

  // Launcher: the pill also tells the model list state, as the old model chip did.
  const statusText = modelName
    ? null
    : modelStatus?.loading
      ? 'Loading model…'
      : (modelStatus?.error?.label ?? null)
  // Loading and setup errors have no model name. Put that status in the
  // accessible name so the pill still announces it.
  const ariaParts = [modelName ?? statusText, effortName, agent.present ? agent.aria : null].filter(
    (part): part is string => Boolean(part)
  )
  const pillAria = ariaParts.join('. ') || 'Model and effort'
  const pending =
    modelSelect.pending || effortSelect.pending || fastSelect.pending || modeSelect.pending
  const armed = Boolean(agent.armedName)
  const pillText = armed
    ? `→ ${modelName ?? agent.armedName}`
    : (modelName ?? statusText ?? (agent.present ? agent.name : (effortName ?? 'Fast')))

  // View-only v2 behind an opt-in flag (default off); same props and source.
  const Panel = v2PanelProps || isModelPickerV2Enabled() ? SelectorPanelV2 : SelectorPanel
  const panelProps: SelectorPanelProps = {
    source,
    touch: isMobile,
    disabled,
    modelOption,
    modelValue: modelSelect.displayValue,
    onPickModel: (value) => modelSelect.select(value),
    thoughtLevel,
    effortValue: effortSelect.displayValue,
    onEffort: (value) => effortSelect.select(value),
    fastMode,
    fastOn,
    onToggleFast: fastNext ? () => fastSelect.select(fastNext) : null,
    genericOptions,
    agentConfigId: source.currentConfigId,
    // Return the setter's promise so a switch waits for the real outcome.
    // Rejections propagate to the footer, which both marks the value
    // unavailable (#1480) and swallows the already-toasted failure — so
    // nothing surfaces as an unhandled rejection here.
    onSetConfig: (configId, valueId) => Promise.resolve(onSetConfig(configId, valueId)),
    usage,
    messages,
    capabilities,
    onClose: close,
    escapeRef
  }

  const panel = <Panel {...v2PanelProps} key={generation} {...panelProps} />

  const trigger = (
    <ComposerPill
      disabled={disabled}
      pending={pending || Boolean(modelStatus?.loading)}
      chevron={!armed}
      chevronDirection="up"
      aria-label={pillAria}
      data-testid="agent-model-selector-trigger"
      className={cn('max-w-[240px]', PRESS)}
    >
      <AgentGlyph
        templateId={agentTemplateId}
        icon={agentIcon}
        size={13}
        className="shrink-0 text-muted-foreground"
      />
      <span className={cn('truncate', armed && 'text-foreground')}>{pillText}</span>
      {!armed && modelName && effortName ? <span className="shrink-0">{effortName}</span> : null}
    </ComposerPill>
  )

  const cancel = agent.armedName ? (
    <button
      type="button"
      disabled={disabled}
      aria-label="Cancel agent switch"
      title="Cancel the armed switch — the next send stays with the current agent"
      data-testid="agent-switch-cancel"
      className="relative inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-[background-color,color] duration-150 ease-out before:absolute before:-inset-2.5 before:content-[''] hover:bg-foreground/10 hover:text-foreground focus-visible:bg-foreground/10 focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      onClick={() => cancelAgentSwitch(sessionId)}
    >
      <X size={10} aria-hidden="true" />
    </button>
  ) : null

  if (isMobile) {
    const modeControl: ModeControl | null =
      modes && modes.availableModes.length > 0
        ? { modes, displayValue: modeSelect.displayValue, onPick: modeSelect.select }
        : null
    const defaultModeId = modeControl?.modes.availableModes[0]?.id
    const nonDefaultMode =
      modeControl && modeControl.displayValue !== defaultModeId
        ? modeControl.modes.availableModes.find((m) => m.id === modeControl.displayValue)
        : undefined
    const phoneAria = [
      modelName ?? statusText,
      effortName,
      nonDefaultMode ? `${nonDefaultMode.name} mode` : null,
      agent.present ? agent.aria : null
    ]
      .filter((part): part is string => Boolean(part))
      .join('. ')
    return (
      <span className="inline-flex min-w-0 items-center gap-0.5">
        <Sheet open={open} onOpenChange={handleOpenChange}>
          <SheetTrigger asChild disabled={disabled}>
            <MobileModelPill
              disabled={disabled}
              agentTemplateId={agentTemplateId}
              agentIcon={agentIcon}
              label={pillText}
              effort={modelName ? effortName : undefined}
              modeId={nonDefaultMode?.id}
              armed={armed}
              pending={pending || Boolean(modelStatus?.loading)}
              aria-label={phoneAria || 'Model and effort'}
              data-testid="agent-model-selector-trigger"
            />
          </SheetTrigger>
          <MobileModelSheet
            key={generation}
            {...panelProps}
            sessionId={sessionId}
            open={open}
            overlayId={overlayId}
            mode={modeControl}
            compact={phone?.compact ?? null}
            claudeProjectId={phone?.claudeProjectId ?? null}
            favoritesStore={v2PanelProps?.favoritesStore}
            onCloseAutoFocus={onCloseAutoFocus}
          />
        </Sheet>
        {cancel}
      </span>
    )
  }

  const shell = (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      <AnimatedMenuContent
        open={open}
        align="end"
        side="top"
        sideOffset={12}
        collisionPadding={12}
        onEscapeKeyDown={onEscapeKeyDown}
        onCloseAutoFocus={onCloseAutoFocus}
        contentClassName="z-[100] max-w-[calc(100vw-1rem)]"
        // Radix writes the room above or below the trigger onto the popper. The
        // panel shrinks its list to fit; the surface scrolls only if that is not enough.
        className="flex max-h-[var(--radix-popper-available-height,70vh)] flex-col overflow-y-auto overscroll-contain rounded-xl border-border p-0"
      >
        {panel}
      </AnimatedMenuContent>
    </Popover>
  )

  return (
    <span className="inline-flex min-w-0 items-center gap-0.5">
      {shell}
      {cancel}
    </span>
  )
}
