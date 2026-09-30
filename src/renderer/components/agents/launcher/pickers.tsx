import { memo, useMemo, useRef, useState } from 'react'
import {
  SELECTOR_OPTION_ROW,
  SELECTOR_OPTION_ROW_DESKTOP,
  SELECTOR_OPTION_ROW_MOBILE,
  SELECTOR_OPTION_SELECTED,
  SELECTOR_SECTION_LABEL,
  SelectorModal,
  SelectorOptionLabel
} from '@/components/chat/AgentHeader'
import { ComposerPill } from '@/components/chat/ComposerPill'
import type { partitionConfigOptions } from '@/components/chat/chat-input-bar-config'
import { useOptimisticSelect } from '@/components/chat/use-optimistic-select'
import { Check } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { AuthMethod } from '@/lib/acp-api'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import {
  filterSupportedAcpAgents,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'
import { cn } from '@/lib/utils'

/** Max finger travel (px) for a touchend to count as a tap, not a drag-scroll. */
const TOUCH_SELECT_THRESHOLD_PX = 10

export function AcpAgentPicker({
  agents,
  selectedEntry,
  selectedConfig,
  disabled,
  installingConfigId,
  updateAgentIds,
  onSelectAgent
}: {
  agents: readonly SupportedAcpAgentEntry[]
  selectedEntry: SupportedAcpAgentEntry | null
  selectedConfig: StoredAgentConfig | null
  disabled: boolean
  installingConfigId: string | null
  /** Agents whose spawn version drifts from the target registry (advisory). */
  updateAgentIds?: ReadonlySet<string>
  onSelectAgent: (entry: SupportedAcpAgentEntry) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const isMobile = useMobileWebShell()
  const visibleAgents = useMemo(() => filterSupportedAcpAgents(agents, query), [agents, query])
  const rawLabel = selectedConfig?.name ?? selectedEntry?.agent.name ?? 'ACP Agent'
  const label = rawLabel.endsWith(' CLI') ? rawLabel.slice(0, -4) : rawLabel

  const trigger = (
    <ComposerPill
      disabled={disabled}
      aria-label={`Select ACP agent: ${label}`}
      className={cn('max-w-[260px]', isMobile && 'min-h-11 py-2')}
      chevron
    >
      <EntryGlyph
        config={selectedConfig}
        templateId={selectedEntry?.agent.id}
        name={selectedEntry?.agent.name}
      />
      <span className="truncate">{label}</span>
    </ComposerPill>
  )

  const contentBody = (
    <>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search agents…"
        aria-label="Search ACP agents"
        className={cn(
          'mb-1 w-full rounded-md bg-background px-2 py-1.5 text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-foreground/20',
          isMobile ? 'text-base' : 'text-sm'
        )}
      />
      <div className="max-h-64 overflow-y-auto pr-1">
        {visibleAgents.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No agents match.</div>
        ) : (
          visibleAgents.map((entry) => {
            const selected = entry.configId === selectedEntry?.configId
            return (
              <button
                key={entry.configId}
                type="button"
                onClick={() => {
                  setOpen(false)
                  onSelectAgent(entry)
                }}
                aria-pressed={selected}
                data-press-feedback="off"
                className={cn(
                  SELECTOR_OPTION_ROW,
                  isMobile ? SELECTOR_OPTION_ROW_MOBILE : SELECTOR_OPTION_ROW_DESKTOP,
                  selected && SELECTOR_OPTION_SELECTED
                )}
              >
                <span className="mt-0.5 inline-flex shrink-0">
                  <EntryGlyph
                    config={entry.config}
                    templateId={entry.agent.id}
                    name={entry.agent.name}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {entry.config?.name ?? entry.agent.name}
                </span>
                {updateAgentIds?.has(entry.agent.id) && (
                  // Entrance signal (user trust): the agent chosen for a new
                  // session visibly shows when it is not on the latest
                  // registry version.
                  <span
                    className="rounded bg-connection/15 px-1.5 py-0.5 text-3xs font-medium text-connection"
                    data-testid={`picker-update-${entry.agent.id}`}
                  >
                    Update
                  </span>
                )}
                {entry.status === 'install-required' && (
                  <span className="rounded bg-foreground/[0.08] px-1.5 py-0.5 text-3xs text-muted-foreground">
                    {installingConfigId === entry.configId ? 'Installing…' : 'Install'}
                  </span>
                )}
                {entry.status === 'needs-runtime' && (
                  <span className="text-3xs text-muted-foreground">
                    {entry.runtimeLauncher === 'uvx' ? 'Needs uv' : 'Needs Node'}
                  </span>
                )}
                {entry.status === 'manual-install' && (
                  <span className="text-3xs text-muted-foreground">Manual install</span>
                )}
                {entry.status === 'unavailable' && (
                  <span className="text-3xs text-muted-foreground">Unavailable</span>
                )}
                <Check
                  size={14}
                  aria-hidden="true"
                  className={cn('mt-0.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')}
                />
              </button>
            )
          })
        )}
      </div>
    </>
  )

  if (isMobile) {
    return (
      <SelectorModal
        open={open}
        onOpenChange={setOpen}
        title="ACP Agent"
        trigger={trigger}
        disabled={disabled}
      >
        {contentBody}
      </SelectorModal>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-1">
        <div className={SELECTOR_SECTION_LABEL}>ACP Agent</div>
        {contentBody}
      </PopoverContent>
    </Popover>
  )
}

export function AcpModelPicker({
  selectedEntry,
  modelOption,
  loading,
  connecting = false,
  stale = false,
  setupError,
  signInMethod,
  onSignIn,
  disabled,
  onRetry,
  onSelectModel
}: {
  selectedEntry: SupportedAcpAgentEntry | null
  modelOption: ReturnType<typeof partitionConfigOptions>['model']
  loading: boolean
  connecting?: boolean
  stale?: boolean
  setupError: PrepareChatError | null
  signInMethod: AuthMethod | null
  onSignIn: () => void
  disabled: boolean
  onRetry: () => void
  onSelectModel: (valueId: string) => void | Promise<void>
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const isMobile = useMobileWebShell()
  // Touch-safe selection (parity with ComposerMenu): record touchstart coords
  // so touchend can distinguish a tap (select) from a drag-scroll (skip). The
  // lastInputType ref guards against touch→mouse synthesis double-fire.
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const lastInputType = useRef<'mouse' | 'touch' | null>(null)
  const { displayValue, pending, select } = useOptimisticSelect(
    modelOption?.currentValue,
    onSelectModel
  )
  const currentModel = modelOption?.options.find((o) => o.value === displayValue)
  // Category-specific label so only a genuine empty-model state reads as a
  // neutral "Model" pill — setup failures get an actionable label instead of a
  // misleading "Model unavailable".
  const label = loading
    ? 'Loading model…'
    : setupError
      ? setupError.label
      : (currentModel?.name ?? 'Model')
  const showSearch = Boolean(modelOption && modelOption.options.length > 5 && !setupError)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredModels =
    modelOption?.options.filter((value) => {
      if (!normalizedQuery) return true
      return [value.name, value.value, value.description ?? '']
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    }) ?? []

  const handleSelectModel = (valueId: string): void => {
    setQuery('')
    setOpen(false)
    select(valueId)
  }

  const trigger = (
    <ComposerPill
      disabled={disabled}
      aria-label={`Select model: ${label}`}
      className={cn(
        'max-w-[220px]',
        isMobile && 'min-h-11 py-2',
        (connecting || stale) && !setupError && 'opacity-80'
      )}
      chevron
      pending={pending || (connecting && !setupError)}
    >
      <span className="truncate">{label}</span>
    </ComposerPill>
  )

  const modelStatusSuffix =
    connecting && !setupError
      ? ' · Connecting…'
      : stale && !connecting && !setupError
        ? ' · Cached'
        : ''

  const modelHeading = (
    <div className={SELECTOR_SECTION_LABEL}>
      Model
      {modelStatusSuffix && (
        <span className="ml-1 font-normal normal-case tracking-normal">{modelStatusSuffix}</span>
      )}
    </div>
  )

  const contentBody = (
    <>
      {selectedEntry?.status !== 'ready' ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {selectedEntry?.status === 'install-required'
            ? 'Install this ACP agent to load model options.'
            : selectedEntry?.status === 'needs-runtime'
              ? 'Install the required runtime before loading model options.'
              : selectedEntry?.status === 'manual-install'
                ? 'Install this agent manually before loading model options.'
                : 'This ACP agent is not available on this platform.'}
        </div>
      ) : !setupError && modelOption ? (
        <>
          {showSearch && (
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models…"
              aria-label="Search models"
              className={cn(
                'mb-1 w-full rounded-md bg-background px-2 py-1.5 text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-foreground/20',
                isMobile ? 'text-base' : 'text-sm'
              )}
            />
          )}
          <div data-testid="acp-model-options" className="max-h-[180px] overflow-y-auto pr-1">
            {filteredModels.length > 0 ? (
              filteredModels.map((value) => (
                <button
                  key={value.value}
                  type="button"
                  onTouchStart={(event) => {
                    const t = event.touches[0]
                    if (t) touchStartRef.current = { x: t.clientX, y: t.clientY }
                  }}
                  onTouchEnd={(event) => {
                    event.preventDefault()
                    const start = touchStartRef.current
                    touchStartRef.current = null
                    const t = event.changedTouches[0]
                    const isTap =
                      start && t
                        ? (t.clientX - start.x) ** 2 + (t.clientY - start.y) ** 2 <=
                          TOUCH_SELECT_THRESHOLD_PX ** 2
                        : true
                    if (!isTap) return
                    lastInputType.current = 'touch'
                    handleSelectModel(value.value)
                    window.setTimeout(() => {
                      if (lastInputType.current === 'touch') lastInputType.current = null
                    }, 500)
                  }}
                  onPointerDown={(event) => {
                    if (event.pointerType === 'touch') return
                    if ((event.button ?? 0) !== 0) return
                    event.preventDefault()
                  }}
                  onClick={(event) => {
                    if (lastInputType.current === 'touch') return
                    event.preventDefault()
                    handleSelectModel(value.value)
                  }}
                  data-press-feedback="off"
                  aria-pressed={value.value === displayValue}
                  className={cn(
                    SELECTOR_OPTION_ROW,
                    isMobile ? SELECTOR_OPTION_ROW_MOBILE : SELECTOR_OPTION_ROW_DESKTOP,
                    value.value === displayValue && SELECTOR_OPTION_SELECTED
                  )}
                >
                  <SelectorOptionLabel
                    name={value.name}
                    description={value.description}
                    selected={value.value === displayValue}
                  />
                </button>
              ))
            ) : (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No models match. Try another name.
              </div>
            )}
          </div>
        </>
      ) : setupError ? (
        <div className="space-y-2 px-2 py-1.5 text-xs text-muted-foreground">
          <div>
            <div className="font-medium text-foreground/85">
              {setupError.category === 'auth' || setupError.category === 'multi-auth'
                ? setupError.label
                : 'Could not load model options.'}
            </div>
            <div className="mt-1 line-clamp-3 break-words">{setupError.detail}</div>
          </div>
          {setupError.category === 'multi-auth' ? null : setupError.category === 'auth' &&
            signInMethod ? (
            <Button type="button" size="sm" className="h-7 text-xs" onClick={onSignIn}>
              {`Sign in with ${signInMethod.name}`}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
        </div>
      ) : (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {loading ? 'Loading model options…' : 'This ACP agent has not advertised model options.'}
        </div>
      )}
    </>
  )

  if (isMobile) {
    return (
      <SelectorModal
        open={open}
        onOpenChange={setOpen}
        title={`Model${modelStatusSuffix}`}
        trigger={trigger}
        disabled={disabled}
      >
        {contentBody}
      </SelectorModal>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-1">
        {modelHeading}
        {contentBody}
      </PopoverContent>
    </Popover>
  )
}

export const EntryGlyph = memo(function EntryGlyph({
  config,
  templateId,
  name
}: {
  config: StoredAgentConfig | null
  templateId?: string
  name?: string
}): React.JSX.Element {
  const normalized = useMemo(() => {
    // Prefer a persisted custom icon (bundled or uploaded) over the catalog.
    if (config?.icon) {
      const sanitized = sanitizeInlineAgentSvg(config.icon)
      if (sanitized) return sanitized
    }
    const key = config?.templateId ?? templateId
    if (!key) return null
    const icon = findBundledIconByKey(`acp:${key}`)?.svg
    return icon ? sanitizeInlineAgentSvg(icon) : null
  }, [config?.icon, config?.templateId, templateId])
  const className = 'h-4 w-4 rounded-sm text-4xs'

  if (normalized) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex shrink-0 text-foreground/80 [&_svg]:h-full [&_svg]:w-full',
          className
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: icon SVG is sanitized via sanitizeInlineAgentSvg (DOMPurify)
        dangerouslySetInnerHTML={{ __html: normalized }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center bg-foreground/10 font-semibold uppercase text-foreground/80',
        className
      )}
    >
      {(config?.name ?? name)?.charAt(0) ?? 'A'}
    </span>
  )
})
