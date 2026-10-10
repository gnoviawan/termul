import { useCallback, useId, useRef, useState } from 'react'
import { AgentGlyph } from '@/components/chat/AgentGlyph'
import { ComposerPill } from '@/components/chat/ComposerPill'
import { isFastModeEnabled, oppositeFastModeValue } from '@/components/chat/chat-input-bar-config'
import { useOptimisticSelect } from '@/components/chat/use-optimistic-select'
import { X } from '@/components/icons'
import { AnimatedMenuContent } from '@/components/ui/animated-menu-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger
} from '@/components/ui/sheet'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { SessionConfigOption, SessionUsage } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { shouldShowSessionUsage } from '../context-usage-utils'
import { SelectorPanel } from './SelectorPanel'
import { type SelectorSource, useSessionSelectorSource } from './selector-source'
import { useCurrentAgentConfigId } from './use-agent-switch'

const PRESS = 'duration-150 ease-out enabled:active:scale-[0.96] motion-reduce:active:scale-100'

const NO_MESSAGES: ReadonlyArray<{ role: string }> = []

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
  onCloseAutoFocus
}: AgentModelSelectorProps): React.JSX.Element | null {
  const isMobile = useMobileWebShell()
  const sessionAgent = useComposerAgentLabel(sessionId)
  const sessionSource = useSessionSelectorSource(sessionId)
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
  const pending = modelSelect.pending || effortSelect.pending || fastSelect.pending
  const armed = Boolean(agent.armedName)
  const pillText = armed
    ? `→ ${modelName ?? agent.armedName}`
    : (modelName ?? statusText ?? (agent.present ? agent.name : (effortName ?? 'Fast')))

  const panel = (
    <SelectorPanel
      key={generation}
      source={source}
      touch={isMobile}
      disabled={disabled}
      modelOption={modelOption}
      modelValue={modelSelect.displayValue}
      onPickModel={(value) => modelSelect.select(value)}
      thoughtLevel={thoughtLevel}
      effortValue={effortSelect.displayValue}
      onEffort={(value) => effortSelect.select(value)}
      fastMode={fastMode}
      fastOn={fastOn}
      onToggleFast={fastNext ? () => fastSelect.select(fastNext) : null}
      genericOptions={genericOptions}
      onSetConfig={(configId, valueId) =>
        // Return the setter's promise so a switch waits for the real outcome.
        // Chat and launcher setters toast, then rethrow. Swallow that rejection
        // here so it does not surface again as an unhandled rejection.
        Promise.resolve(onSetConfig(configId, valueId)).catch(() => undefined)
      }
      usage={usage}
      messages={messages}
      onClose={close}
      escapeRef={escapeRef}
    />
  )

  const trigger = (
    <ComposerPill
      disabled={disabled}
      pending={pending || Boolean(modelStatus?.loading)}
      chevron={!armed}
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

  const shell = isMobile ? (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild disabled={disabled}>
        {trigger}
      </SheetTrigger>
      <SheetContent
        side="bottom"
        onEscapeKeyDown={onEscapeKeyDown}
        onCloseAutoFocus={onCloseAutoFocus}
        // The sheet's built-in close button stays (a visible way out beside the
        // grabber and a tap on the scrim). The sheet scrolls inside the 85dvh
        // cap every bottom sheet shares, so a long panel never outgrows a
        // landscape phone.
        className="gap-0 border-border bg-popover p-0 pb-[env(safe-area-inset-bottom)] pt-2 max-h-[85dvh] overflow-y-auto overscroll-contain"
      >
        <div aria-hidden="true" className="mx-auto mb-1.5 h-1 w-9 rounded-full bg-foreground/20" />
        <SheetTitle className="sr-only">Model and agent</SheetTitle>
        <SheetDescription className="sr-only">
          Choose a model, an agent, and its options.
        </SheetDescription>
        {panel}
      </SheetContent>
    </Sheet>
  ) : (
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
        className="overflow-hidden rounded-xl border-border p-0"
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
