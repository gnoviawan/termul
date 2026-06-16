import type { LastSelectedAgent } from '@shared/types/persistence.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { ArrowUp, Check, ChevronDown, Loader2, Settings2 } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ConfigChip, ModeChip } from '@/components/chat/AgentHeader'
import { partitionConfigOptions } from '@/components/chat/chat-input-bar-config'
import { LoadedSkillChip } from '@/components/chat/LoadedSkillChip'
import { SlashCommandMenu, type SlashMenuHandle } from '@/components/chat/SlashCommandMenu'
import { tryHandleSlashMenuKeyDown } from '@/components/chat/slash-menu-keyboard'
import {
  buildSlashSections,
  isSlashTrigger,
  type SlashItem,
  slashFilter
} from '@/components/chat/slash-menu-model'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  buildPromptWithLoadedSkill,
  type LoadedAgentSkill,
  useAgentSkills
} from '@/hooks/use-agent-skills'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import { persistenceApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { prepareChatKey, useAcpSession, useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

interface AgentLauncherProps {
  paneId: string
  className?: string
}

const EMPTY_COMMANDS: [] = []

/** Survives overlay unmount so the new-thread picker does not flash the default. */
let cachedConfigId: string | null = null

/** Test-only: clear the cross-unmount selection cache. */
export function __resetLauncherSelectionCache(): void {
  cachedConfigId = null
}

export function AgentLauncher({ paneId, className }: AgentLauncherProps): React.JSX.Element {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [loadedSkill, setLoadedSkill] = useState<LoadedAgentSkill | null>(null)
  const [selectedConfigId, setSelectedConfigId] = useState(() => cachedConfigId ?? '')
  const [isLaunching, setIsLaunching] = useState(false)
  const menuRef = useRef<SlashMenuHandle>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const acpConfigs = useAcpStore((s) => s.agentConfigs)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const projectRoot = activeProjectId ? getDefaultCwdForProject(activeProjectId) : undefined

  const selectedConfig = useMemo(
    () => acpConfigs.find((c) => c.id === selectedConfigId) ?? acpConfigs[0] ?? null,
    [acpConfigs, selectedConfigId]
  )
  const activeConfigId = selectedConfig?.id ?? ''
  const preparedKey =
    activeConfigId && projectRoot ? prepareChatKey(activeConfigId, projectRoot, undefined) : null
  const preparedSessionId = useAcpStore((s) =>
    preparedKey ? (s.preparedSessions[preparedKey] ?? null) : null
  )
  const isPreparing = useAcpStore((s) =>
    preparedKey ? Boolean(s.preparingChatKeys[preparedKey]) : false
  )
  const draftSession = useAcpSession(preparedSessionId)
  const pendingAuth = useAcpStore((s) =>
    draftSession ? (s.pendingAuth[draftSession.agentId] ?? null) : null
  )
  const commands = useAcpStore((s) =>
    preparedSessionId ? (s.commands[preparedSessionId] ?? EMPTY_COMMANDS) : EMPTY_COMMANDS
  )
  const { skills } = useAgentSkills(acpConfigs.length > 0 ? projectRoot : undefined)

  const usableConfigOptions = (draftSession?.configOptions ?? []).filter(
    (o) => o.options.length > 0
  )
  const {
    model,
    thoughtLevel,
    rest: genericConfigOptions
  } = partitionConfigOptions(usableConfigOptions)
  const menuOpen = isSlashTrigger(prompt)
  const slashSections = useMemo(
    () =>
      menuOpen
        ? buildSlashSections({
            commands,
            configOptions: draftSession?.configOptions ?? [],
            modes: draftSession?.modes ?? null,
            skills,
            filter: slashFilter(prompt)
          })
        : [],
    [menuOpen, commands, draftSession?.configOptions, draftSession?.modes, skills, prompt]
  )

  const persistSelection = useCallback((config: StoredAgentConfig) => {
    cachedConfigId = config.id
    void persistenceApi.write<LastSelectedAgent>(PersistenceKeys.lastSelectedAgent, {
      agentId: config.id,
      mode: 'acp'
    })
  }, [])

  useEffect(() => {
    if (selectedConfigId || acpConfigs.length === 0) return
    let cancelled = false
    void (async () => {
      try {
        const persisted = await persistenceApi.read<unknown>(PersistenceKeys.lastSelectedAgent)
        if (cancelled) return
        const raw = persisted.success ? persisted.data : null
        const saved = raw as Partial<LastSelectedAgent> | null
        const restored =
          saved?.mode === 'acp' && typeof saved.agentId === 'string'
            ? acpConfigs.find((c) => c.id === saved.agentId)
            : null
        const next = restored ?? acpConfigs[0]
        if (next) {
          setSelectedConfigId(next.id)
          persistSelection(next)
        }
      } catch {
        const next = acpConfigs[0]
        if (next) setSelectedConfigId(next.id)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [acpConfigs, persistSelection, selectedConfigId])

  useEffect(() => {
    if (!activeConfigId || !projectRoot) return
    useAcpStore.getState().prepareChat(activeConfigId, projectRoot)
    const key = prepareChatKey(activeConfigId, projectRoot, undefined)
    return () => {
      useAcpStore.getState().cancelPreparedChat(key)
    }
  }, [activeConfigId, projectRoot])

  const openAgentSettings = useCallback(() => {
    useWorkspaceStore.getState().hideAgentLauncher()
    navigate('/preferences')
  }, [navigate])

  const handleSelectConfig = useCallback(
    (config: StoredAgentConfig) => {
      setSelectedConfigId(config.id)
      persistSelection(config)
      textareaRef.current?.focus()
    },
    [persistSelection]
  )

  const handleSetConfig = useCallback(
    (configId: string, valueId: string) => {
      if (!preparedSessionId) return
      void useAcpStore
        .getState()
        .setConfigOption(preparedSessionId, configId, valueId)
        .catch((err) => toast.error(`Failed to set option: ${String(err)}`))
    },
    [preparedSessionId]
  )

  const handleSetMode = useCallback(
    (modeId: string) => {
      if (!preparedSessionId) return
      void useAcpStore
        .getState()
        .setMode(preparedSessionId, modeId)
        .catch((err) => toast.error(`Failed to set agent: ${String(err)}`))
    },
    [preparedSessionId]
  )

  const handleSlashSelect = useCallback(
    (item: SlashItem) => {
      if (item.kind === 'skill') {
        setLoadedSkill({ name: item.name, description: item.description ?? '' })
        setPrompt('')
        textareaRef.current?.focus()
        return
      }
      if (item.kind === 'config') {
        handleSetConfig(item.configId, item.valueId)
      } else if (item.kind === 'mode') {
        handleSetMode(item.modeId)
      } else if (item.kind === 'command') {
        setPrompt(`/${item.name} `)
        textareaRef.current?.focus()
        return
      }
      setPrompt('')
    },
    [handleSetConfig, handleSetMode]
  )

  const launch = useCallback(async () => {
    if (!activeProjectId || !projectRoot) {
      toast.error('No active project')
      return
    }
    if (!selectedConfig || isLaunching) return
    if (pendingAuth) {
      toast.error('This agent requires authentication before a chat can start.')
      return
    }

    setIsLaunching(true)
    try {
      persistSelection(selectedConfig)
      const sessionId = await useAcpStore.getState().startChat(selectedConfig.id, projectRoot)
      useWorkspaceStore.getState().addAgentChatTab(sessionId, paneId)
      const text = await buildPromptWithLoadedSkill(loadedSkill, prompt, projectRoot)
      if (text.trim().length > 0) {
        void useAcpStore.getState().sendPrompt(sessionId, text.trim())
      }
      setLoadedSkill(null)
      useWorkspaceStore.getState().hideAgentLauncher()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start agent chat')
    } finally {
      setIsLaunching(false)
    }
  }, [
    activeProjectId,
    projectRoot,
    selectedConfig,
    isLaunching,
    pendingAuth,
    persistSelection,
    paneId,
    loadedSkill,
    prompt
  ])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        tryHandleSlashMenuKeyDown(e, {
          menuOpen,
          sectionsLength: slashSections.length,
          menuRef,
          onClearInput: () => setPrompt('')
        })
      ) {
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !menuOpen) {
        e.preventDefault()
        void launch()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void launch()
      }
      if (e.key === 'Escape' && !menuOpen) {
        useWorkspaceStore.getState().hideAgentLauncher()
      }
    },
    [launch, menuOpen, slashSections.length]
  )

  const canLaunch =
    Boolean(selectedConfig) &&
    !isLaunching &&
    !pendingAuth &&
    (prompt.trim().length > 0 || loadedSkill !== null)

  if (acpConfigs.length === 0) {
    return (
      <div className={cn('absolute inset-0 flex items-center justify-center p-8', className)}>
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Settings2 size={20} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">No ACP agents enabled</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Enable an ACP coding agent in Application Preferences to start a new agent chat.
            </p>
          </div>
          <Button type="button" size="sm" onClick={openAgentSettings}>
            Open Preferences
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn('absolute inset-0 flex flex-col items-center justify-center p-8', className)}
    >
      <div className="mb-8 flex flex-col items-center gap-4 text-center">
        <EntryGlyph config={selectedConfig} size="lg" />
        <h1 className="text-3xl font-medium tracking-tight text-foreground md:text-4xl">
          What should we do <span className="text-muted-foreground/55">in this folder?</span>
        </h1>
      </div>

      <div className="flex w-full max-w-4xl flex-col gap-4">
        <div className="relative">
          {menuOpen && (
            <SlashCommandMenu ref={menuRef} sections={slashSections} onSelect={handleSlashSelect} />
          )}
          <div className="overflow-hidden rounded-3xl border border-border bg-card shadow-sm transition-colors focus-within:border-border/80 focus-within:ring-1 focus-within:ring-border/50">
            {loadedSkill && (
              <LoadedSkillChip skill={loadedSkill} onRemove={() => setLoadedSkill(null)} />
            )}
            <div className="px-5 pb-2 pt-4">
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  loadedSkill
                    ? 'Add a message (optional)…'
                    : 'Ask for follow-up changes or attach images'
                }
                rows={2}
                aria-label="Agent prompt"
                autoFocus
                className="max-h-40 min-h-[76px] w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground/55"
                onInput={(e) => {
                  const el = e.currentTarget
                  el.style.height = 'auto'
                  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3 px-3 pb-3">
              <button
                type="button"
                className="flex h-[34px] w-[34px] items-center justify-center rounded-full text-xl leading-none text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                title="Attachments are not available yet"
                aria-label="Add attachment"
              >
                +
              </button>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <AcpModelPicker
                  configs={acpConfigs}
                  selectedConfig={selectedConfig}
                  modelOption={model}
                  loading={isPreparing && !draftSession}
                  disabled={isLaunching}
                  onSelectConfig={handleSelectConfig}
                  onSelectModel={(valueId) => model && handleSetConfig(model.id, valueId)}
                />
                {thoughtLevel && (
                  <ConfigChip
                    option={thoughtLevel}
                    disabled={!draftSession || Boolean(pendingAuth)}
                    promoted
                    onSelect={(valueId) => handleSetConfig(thoughtLevel.id, valueId)}
                  />
                )}
                {genericConfigOptions.map((option) => (
                  <ConfigChip
                    key={option.id}
                    option={option}
                    disabled={!draftSession || Boolean(pendingAuth)}
                    onSelect={(valueId) => handleSetConfig(option.id, valueId)}
                  />
                ))}
                {draftSession && (
                  <ModeChip
                    session={draftSession}
                    disabled={Boolean(pendingAuth)}
                    onSelect={handleSetMode}
                    label="Agent"
                  />
                )}
                <button
                  type="button"
                  onClick={() => void launch()}
                  disabled={!canLaunch}
                  className={cn(
                    'flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full transition-colors',
                    canLaunch
                      ? 'bg-foreground text-background hover:bg-foreground/90'
                      : 'cursor-not-allowed bg-foreground/20 text-background/70'
                  )}
                  aria-label="Start agent chat"
                  title={isLaunching ? 'Starting…' : 'Start agent chat'}
                >
                  {isLaunching ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <ArrowUp size={18} />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion.title}
              type="button"
              onClick={() => {
                setPrompt(suggestion.prompt)
                textareaRef.current?.focus()
              }}
              className="rounded-2xl border border-border bg-card/60 px-4 py-3 text-left transition-colors hover:bg-muted/45"
            >
              <div className="text-sm font-medium text-foreground">{suggestion.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {suggestion.description}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function AcpModelPicker({
  configs,
  selectedConfig,
  modelOption,
  loading,
  disabled,
  onSelectConfig,
  onSelectModel
}: {
  configs: readonly StoredAgentConfig[]
  selectedConfig: StoredAgentConfig | null
  modelOption: ReturnType<typeof partitionConfigOptions>['model']
  loading: boolean
  disabled: boolean
  onSelectConfig: (config: StoredAgentConfig) => void
  onSelectModel: (valueId: string) => void
}): React.JSX.Element {
  const currentModel = modelOption?.options.find((o) => o.value === modelOption.currentValue)
  const label = currentModel?.name ?? selectedConfig?.name ?? 'ACP Agent'
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          className="flex h-[34px] max-w-[260px] items-center gap-2 rounded-xl bg-foreground/[0.06] px-3 text-xs text-foreground/85 hover:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <EntryGlyph config={selectedConfig} />
          <span className="truncate">{loading ? 'Preparing agent…' : label}</span>
          <ChevronDown size={12} className="text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-1">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          ACP Agent
        </div>
        {configs.map((config) => (
          <button
            key={config.id}
            type="button"
            onClick={() => onSelectConfig(config)}
            className={cn(
              'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
              config.id === selectedConfig?.id && 'bg-accent/50'
            )}
          >
            <EntryGlyph config={config} />
            <span className="min-w-0 flex-1 truncate">{config.name}</span>
            {config.id === selectedConfig?.id && (
              <Check size={14} className="text-muted-foreground" />
            )}
          </button>
        ))}
        <div className="my-1 h-px bg-border" />
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Model
        </div>
        {modelOption ? (
          modelOption.options.map((value) => (
            <button
              key={value.value}
              type="button"
              onClick={() => onSelectModel(value.value)}
              className={cn(
                'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
                value.value === modelOption.currentValue && 'bg-accent/50'
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{value.name}</span>
                {value.description && (
                  <span className="block text-xs text-muted-foreground">{value.description}</span>
                )}
              </span>
              {value.value === modelOption.currentValue && (
                <Check size={14} className="mt-0.5 text-muted-foreground" />
              )}
            </button>
          ))
        ) : (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {loading
              ? 'Loading model options…'
              : 'This ACP agent has not advertised model options.'}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

const EntryGlyph = memo(function EntryGlyph({
  config,
  size = 'sm'
}: {
  config: StoredAgentConfig | null
  size?: 'sm' | 'lg'
}): React.JSX.Element {
  const normalized = useMemo(() => {
    if (!config?.templateId) return null
    const icon = findBundledIconByKey(`acp:${config.templateId}`)?.svg
    return icon ? sanitizeInlineAgentSvg(icon) : null
  }, [config?.templateId])
  const className =
    size === 'lg' ? 'h-12 w-12 rounded-2xl text-base' : 'h-4 w-4 rounded-sm text-[9px]'

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
      {config?.name.charAt(0) ?? 'A'}
    </span>
  )
})

const SUGGESTIONS = [
  {
    title: 'Find the next best task',
    description: 'Look across the recent project work and current repo state.',
    prompt: 'Find the next best task for this project.'
  },
  {
    title: 'Do a focused quality pass',
    description: 'Audit this project for the most likely rough edge from recent work.',
    prompt: 'Do a focused quality pass on this project.'
  },
  {
    title: 'Prepare a project handoff',
    description: 'Summarize what matters in this project right now.',
    prompt: 'Prepare a clean project handoff.'
  }
] as const
