import { memo, useMemo, useState } from 'react'
import { SelectedCheck, SelectorModal, SelectorOptionLabel } from '@/components/chat/AgentHeader'
import { ComposerPill } from '@/components/chat/ComposerPill'
import {
  flattenConfigOptionValues,
  type partitionConfigOptions
} from '@/components/chat/chat-input-bar-config'
import { useOptimisticSelect } from '@/components/chat/use-optimistic-select'
import { keepFocusOnMousePress, useTapSelect } from '@/components/chat/use-tap-select'
import { Button } from '@/components/ui/button'
import {
  MENU_LABEL_CLASS,
  menuOptionRowClass,
  pickerSearchTextClass
} from '@/components/ui/menu-styles'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PopoverSearchBand } from '@/components/ui/popover-search-band'
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

  const searchBand = (
    <PopoverSearchBand
      value={query}
      onChange={setQuery}
      placeholder="Search agents…"
      ariaLabel="Search ACP agents"
      inputClassName={pickerSearchTextClass(isMobile)}
    />
  )

  const agentList = (
    <div className="max-h-64 overflow-y-auto">
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
              className={menuOptionRowClass(isMobile)}
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
              <EntryStatusTag
                status={entry.status}
                runtimeLauncher={entry.runtimeLauncher}
                installing={installingConfigId === entry.configId}
              />
              <SelectedCheck selected={selected} />
            </button>
          )
        })
      )}
    </div>
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
        <div className="-mx-1">{searchBand}</div>
        <div className="pt-1">{agentList}</div>
      </SelectorModal>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 rounded-xl p-0">
        {searchBand}
        <div className="p-1">
          <div className={MENU_LABEL_CLASS}>ACP Agent</div>
          {agentList}
        </div>
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
  const tapSelect = useTapSelect()
  const { displayValue, pending, select } = useOptimisticSelect(
    typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined,
    onSelectModel
  )
  const modelValues = modelOption ? flattenConfigOptionValues(modelOption) : []
  const currentModel = modelValues.find((o) => o.value === displayValue)
  // Category-specific label so only a genuine empty-model state reads as a
  // neutral "Model" pill — setup failures get an actionable label instead of a
  // misleading "Model unavailable".
  const label = loading
    ? 'Loading model…'
    : setupError
      ? setupError.label
      : (currentModel?.name ?? 'Model')
  const showSearch = Boolean(modelOption && modelValues.length > 5 && !setupError)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredModels =
    modelValues
      .filter((value): value is typeof value & { value: string } => typeof value.value === 'string')
      .filter((value) => {
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
    <div className={MENU_LABEL_CLASS}>
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
            // -mx-1 lets the hairline run edge to edge inside the p-1 shell.
            <div className="-mx-1 mb-1">
              <PopoverSearchBand
                value={query}
                onChange={setQuery}
                placeholder="Search models…"
                ariaLabel="Search models"
                inputClassName={pickerSearchTextClass(isMobile)}
              />
            </div>
          )}
          <div data-testid="acp-model-options" className="max-h-[180px] overflow-y-auto">
            {filteredModels.length > 0 ? (
              filteredModels.map((value) => (
                <button
                  key={value.value}
                  type="button"
                  {...tapSelect(() => handleSelectModel(value.value))}
                  onPointerDown={keepFocusOnMousePress}
                  data-press-feedback="off"
                  aria-pressed={value.value === displayValue}
                  className={menuOptionRowClass(isMobile)}
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
      <PopoverContent align="end" side="top" className="w-72 rounded-xl p-1">
        {modelHeading}
        {contentBody}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Trailing tag on an agent row that cannot start yet (install, runtime,
 * manual install, unavailable). Ready rows render nothing.
 */
export function EntryStatusTag({
  status,
  runtimeLauncher,
  installing
}: Pick<SupportedAcpAgentEntry, 'status' | 'runtimeLauncher'> & {
  installing: boolean
}): React.JSX.Element | null {
  switch (status) {
    case 'install-required':
      return (
        <span className="rounded bg-foreground/[0.08] px-1.5 py-0.5 text-3xs text-muted-foreground">
          {installing ? 'Installing…' : 'Install'}
        </span>
      )
    case 'needs-runtime':
      return (
        <span className="text-3xs text-muted-foreground">
          {runtimeLauncher === 'uvx' ? 'Needs uv' : 'Needs Node'}
        </span>
      )
    case 'manual-install':
      return <span className="text-3xs text-muted-foreground">Manual install</span>
    case 'unavailable':
      return <span className="text-3xs text-muted-foreground">Unavailable</span>
    default:
      return null
  }
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
