import type { LastSelectedAgent } from '@shared/types/persistence.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { ArrowUp, Check, Download, Loader2, Paperclip } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ConfigChip, ModeChip } from '@/components/chat/AgentHeader'
import { AttachmentPreviewGroup } from '@/components/chat/AttachmentPreviewGroup'
import { ComposerPill } from '@/components/chat/ComposerPill'
import { attachmentToBlock } from '@/components/chat/chat-attachments'
import {
  filterDuplicateModeConfigOptions,
  partitionConfigOptions,
  resolveModelOption
} from '@/components/chat/chat-input-bar-config'
import { LoadedSkillChip } from '@/components/chat/LoadedSkillChip'
import { SlashCommandMenu, type SlashMenuHandle } from '@/components/chat/SlashCommandMenu'
import { tryHandleSlashMenuKeyDown } from '@/components/chat/slash-menu-keyboard'
import {
  buildSlashSections,
  isSlashTrigger,
  type SlashItem,
  slashFilter
} from '@/components/chat/slash-menu-model'
import { useComposerAttachments } from '@/components/chat/use-composer-attachments'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  buildPromptWithLoadedSkill,
  type LoadedAgentSkill,
  useAgentSkills
} from '@/hooks/use-agent-skills'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { acpApi, type ContentBlock } from '@/lib/acp-api'
import { currentPlatformArch } from '@/lib/agents/acp-registry'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import {
  buildSupportedAcpAgents,
  installedBinaryConfig,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'
import { persistenceApi } from '@/lib/api'
import { cn } from '@/lib/utils'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { prepareChatKey, useAcpSession, useAcpStore } from '@/stores/acp-store'
import { useActiveProject, useProjectStore } from '@/stores/project-store'
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
  const [prompt, setPrompt] = useState('')
  const [loadedSkill, setLoadedSkill] = useState<LoadedAgentSkill | null>(null)
  const [selectedConfigId, setSelectedConfigId] = useState(() => cachedConfigId ?? '')
  const [isLaunching, setIsLaunching] = useState(false)
  const [installingConfigId, setInstallingConfigId] = useState<string | null>(null)
  const menuRef = useRef<SlashMenuHandle>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const acpConfigs = useAcpStore((s) => s.agentConfigs)
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProject = useActiveProject()
  const projectLabel = activeProject?.name ?? 'this folder'
  const projectRoot = activeProjectId ? getDefaultCwdForProject(activeProjectId) : undefined
  const platformArch = useMemo(() => currentPlatformArch(), [])
  const supportedAgents = useMemo(
    () => buildSupportedAcpAgents(acpConfigs, platformArch),
    [acpConfigs, platformArch]
  )

  const selectedEntry = useMemo(
    () =>
      supportedAgents.find((entry) => entry.configId === selectedConfigId) ??
      supportedAgents.find((entry) => entry.status === 'ready') ??
      supportedAgents[0] ??
      null,
    [supportedAgents, selectedConfigId]
  )
  const selectedConfig = selectedEntry?.config ?? null
  const activeConfigId = selectedConfig?.id ?? ''
  const preparedKey =
    activeConfigId && projectRoot ? prepareChatKey(activeConfigId, projectRoot, undefined) : null
  const preparedSessionId = useAcpStore((s) =>
    preparedKey ? (s.preparedSessions[preparedKey] ?? null) : null
  )
  const isPreparing = useAcpStore((s) =>
    preparedKey ? Boolean(s.preparingChatKeys[preparedKey]) : false
  )
  const prepareError = useAcpStore((s) =>
    preparedKey ? (s.prepareChatErrors[preparedKey] ?? null) : null
  )
  const draftSession = useAcpSession(preparedSessionId)
  const promptCaps = useAcpStore((s) =>
    draftSession?.agentId
      ? s.agents?.[draftSession.agentId]?.capabilities?.promptCapabilities
      : undefined
  )
  const imageCapable = Boolean(promptCaps?.image)
  const embedCapable = Boolean(promptCaps?.embeddedContext)
  const composerDisabled =
    isLaunching || Boolean(installingConfigId) || selectedEntry?.status !== 'ready'
  const {
    attachments,
    addFiles,
    pickFiles,
    handlePaste,
    removeAttachment,
    clearAttachments,
    canPick,
    canDropPaste
  } = useComposerAttachments({ imageCapable, embedCapable, disabled: composerDisabled })
  const commands = useAcpStore((s) =>
    preparedSessionId ? (s.commands[preparedSessionId] ?? EMPTY_COMMANDS) : EMPTY_COMMANDS
  )
  const { skills } = useAgentSkills(
    supportedAgents.some((entry) => entry.status === 'ready') ? projectRoot : undefined
  )

  const usableConfigOptions = (draftSession?.configOptions ?? []).filter(
    (o) => o.options.length > 0
  )
  const {
    model,
    thoughtLevel,
    rest: genericConfigOptions
  } = partitionConfigOptions(usableConfigOptions)
  const { option: modelOption, source: modelSource } = resolveModelOption(
    model,
    draftSession?.models
  )
  const visibleGenericConfigOptions = filterDuplicateModeConfigOptions(
    genericConfigOptions,
    draftSession?.modes ?? null
  )
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

  const persistSelection = useCallback((configId: string) => {
    cachedConfigId = configId
    void persistenceApi.write<LastSelectedAgent>(PersistenceKeys.lastSelectedAgent, {
      agentId: configId,
      mode: 'acp'
    })
  }, [])

  useEffect(() => {
    if (selectedConfigId || supportedAgents.length === 0) return
    let cancelled = false
    void (async () => {
      try {
        const persisted = await persistenceApi.read<unknown>(PersistenceKeys.lastSelectedAgent)
        if (cancelled) return
        const raw = persisted.success ? persisted.data : null
        const saved = raw as Partial<LastSelectedAgent> | null
        const restored =
          saved?.mode === 'acp' && typeof saved.agentId === 'string'
            ? supportedAgents.find((entry) => entry.configId === saved.agentId)
            : null
        const next =
          restored ??
          supportedAgents.find((entry) => entry.status === 'ready') ??
          supportedAgents[0]
        if (next) {
          setSelectedConfigId(next.configId)
          persistSelection(next.configId)
        }
      } catch {
        const next = supportedAgents.find((entry) => entry.status === 'ready') ?? supportedAgents[0]
        if (next) setSelectedConfigId(next.configId)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [persistSelection, selectedConfigId, supportedAgents])

  useEffect(() => {
    if (!activeConfigId || !projectRoot || selectedEntry?.status !== 'ready' || !selectedConfig)
      return
    let cancelled = false
    void (async () => {
      try {
        if (!acpConfigs.some((config) => config.id === selectedConfig.id)) {
          await saveAgentConfig(selectedConfig)
          if (cancelled) return
        }
        useAcpStore.getState().prepareChat(activeConfigId, projectRoot, undefined, activeProjectId)
      } catch (err) {
        console.warn('[acp] failed to prepare supported agent', activeConfigId, err)
      }
    })()
    const key = prepareChatKey(activeConfigId, projectRoot, undefined)
    return () => {
      cancelled = true
      useAcpStore.getState().cancelPreparedChat(key)
    }
  }, [
    activeConfigId,
    acpConfigs,
    projectRoot,
    saveAgentConfig,
    selectedConfig,
    selectedEntry?.status,
    activeProjectId
  ])

  const handleSelectAgent = useCallback(
    (entry: SupportedAcpAgentEntry) => {
      setSelectedConfigId(entry.configId)
      persistSelection(entry.configId)
      textareaRef.current?.focus()
    },
    [persistSelection]
  )

  const handleInstallAgent = useCallback(
    async (entry: SupportedAcpAgentEntry) => {
      if (!entry.install || installingConfigId) return
      setSelectedConfigId(entry.configId)
      persistSelection(entry.configId)
      setInstallingConfigId(entry.configId)
      try {
        const installed = await acpApi.installRegistryBinary({
          agentId: entry.agent.id,
          archiveUrl: entry.install.archiveUrl,
          cmd: entry.install.cmd,
          args: entry.install.args
        })
        const config = installedBinaryConfig(entry.agent, installed, { env: entry.install.env })
        await saveAgentConfig(config)
        setSelectedConfigId(config.id)
        persistSelection(config.id)
        toast.success(`${entry.agent.name} installed`)
      } catch (err) {
        toast.error(`Failed to install ${entry.agent.name}: ${String(err)}`)
      } finally {
        setInstallingConfigId(null)
      }
    },
    [installingConfigId, persistSelection, saveAgentConfig]
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

  const handleSetModel = useCallback(
    (valueId: string) => {
      if (!preparedSessionId) return
      if (modelSource === 'models') {
        void useAcpStore
          .getState()
          .setModel(preparedSessionId, valueId)
          .catch((err) => toast.error(`Failed to set model: ${String(err)}`))
        return
      }
      if (modelOption) handleSetConfig(modelOption.id, valueId)
    },
    [handleSetConfig, modelOption, modelSource, preparedSessionId]
  )

  const handleRetryPrepare = useCallback(() => {
    if (!activeConfigId || !projectRoot || !preparedKey) return
    const store = useAcpStore.getState()
    store.cancelPreparedChat(preparedKey)
    store.prepareChat(activeConfigId, projectRoot, undefined, activeProjectId)
  }, [activeConfigId, preparedKey, projectRoot, activeProjectId])

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
    if (!selectedConfig || selectedEntry?.status !== 'ready' || isLaunching) return

    setIsLaunching(true)
    try {
      if (!acpConfigs.some((config) => config.id === selectedConfig.id)) {
        await saveAgentConfig(selectedConfig)
      }
      persistSelection(selectedConfig.id)
      const sessionId = await useAcpStore
        .getState()
        .startChat(selectedConfig.id, projectRoot, undefined, activeProjectId)
      useWorkspaceStore.getState().addAgentChatTab(sessionId, paneId)
      const text = await buildPromptWithLoadedSkill(loadedSkill, prompt, projectRoot)
      const trimmed = text.trim()
      if (attachments.length > 0) {
        const blocks: ContentBlock[] = []
        if (trimmed) blocks.push({ type: 'text', text })
        for (const a of attachments) blocks.push(attachmentToBlock(a))
        void useAcpStore.getState().sendPromptBlocks(sessionId, blocks)
      } else if (trimmed.length > 0) {
        void useAcpStore.getState().sendPrompt(sessionId, trimmed)
      }
      setLoadedSkill(null)
      clearAttachments()
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
    selectedEntry?.status,
    isLaunching,
    acpConfigs,
    saveAgentConfig,
    persistSelection,
    paneId,
    loadedSkill,
    prompt,
    attachments,
    clearAttachments
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
    selectedEntry?.status === 'ready' &&
    !isLaunching &&
    (prompt.trim().length > 0 || loadedSkill !== null || attachments.length > 0)

  return (
    <div
      className={cn('absolute inset-0 flex flex-col items-center justify-center p-8', className)}
    >
      <div className="mb-8 flex flex-col items-center gap-4 text-center">
        <EntryGlyph
          config={selectedConfig}
          templateId={selectedEntry?.agent.id}
          name={selectedEntry?.agent.name}
          size="lg"
        />
        <h1 className="text-3xl font-medium tracking-tight text-foreground md:text-4xl">
          {`What should we do in ${projectLabel}?`}
        </h1>
      </div>

      <div className="flex w-full max-w-4xl flex-col gap-4">
        <div className="relative">
          {menuOpen && (
            <SlashCommandMenu ref={menuRef} sections={slashSections} onSelect={handleSlashSelect} />
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for attachments; the file picker button is the accessible path */}
          <div
            className="rounded-2xl border border-border/60 bg-card transition-colors focus-within:border-border"
            onDragOver={canDropPaste ? (e) => e.preventDefault() : undefined}
            onDrop={
              canDropPaste
                ? (e) => {
                    if (e.dataTransfer.files.length === 0) return
                    e.preventDefault()
                    void addFiles(e.dataTransfer.files)
                  }
                : undefined
            }
          >
            {selectedEntry?.status === 'install-required' && (
              <InstallRequiredBanner
                entry={selectedEntry}
                installing={installingConfigId === selectedEntry.configId}
                onInstall={() => void handleInstallAgent(selectedEntry)}
              />
            )}
            {selectedEntry?.status === 'unavailable' && (
              <div className="border-b border-border/60 px-5 py-3 text-xs text-muted-foreground">
                {selectedEntry.unavailableReason ??
                  'This ACP agent is not available on this platform.'}
              </div>
            )}
            {loadedSkill && (
              <LoadedSkillChip skill={loadedSkill} onRemove={() => setLoadedSkill(null)} />
            )}
            <AttachmentPreviewGroup
              attachments={attachments}
              onRemove={removeAttachment}
              className="px-5 pt-4"
            />
            <div className="px-5 pb-2 pt-4">
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                  loadedSkill
                    ? 'Add a message (optional)…'
                    : 'Ask for follow-up changes or attach files'
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
                onClick={() => void pickFiles()}
                disabled={!canPick}
                className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                title="Attach files"
                aria-label="Attach files"
              >
                <Paperclip size={16} />
              </button>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2.5">
                <AcpAgentPicker
                  agents={supportedAgents}
                  selectedEntry={selectedEntry}
                  selectedConfig={selectedConfig}
                  disabled={isLaunching || Boolean(installingConfigId)}
                  installingConfigId={installingConfigId}
                  onSelectAgent={handleSelectAgent}
                />
                <AcpModelPicker
                  selectedEntry={selectedEntry}
                  modelOption={modelOption}
                  loading={!prepareError && isPreparing && !draftSession}
                  errorMessage={prepareError}
                  disabled={isLaunching || Boolean(installingConfigId)}
                  onRetry={handleRetryPrepare}
                  onSelectModel={handleSetModel}
                />
                {thoughtLevel && (
                  <ConfigChip
                    option={thoughtLevel}
                    disabled={!draftSession}
                    promoted
                    onSelect={(valueId) => handleSetConfig(thoughtLevel.id, valueId)}
                  />
                )}
                {visibleGenericConfigOptions.map((option) => (
                  <ConfigChip
                    key={option.id}
                    option={option}
                    disabled={!draftSession}
                    onSelect={(valueId) => handleSetConfig(option.id, valueId)}
                  />
                ))}
                {draftSession && (
                  <ModeChip
                    session={draftSession}
                    disabled={false}
                    onSelect={handleSetMode}
                    label="Agent"
                  />
                )}
                <button
                  type="button"
                  onClick={() => void launch()}
                  disabled={!canLaunch}
                  className={cn(
                    'flex size-[34px] shrink-0 items-center justify-center rounded-lg transition-colors',
                    canLaunch
                      ? 'bg-foreground text-background hover:bg-foreground/90'
                      : 'cursor-not-allowed bg-muted text-muted-foreground'
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

function InstallRequiredBanner({
  entry,
  installing,
  onInstall
}: {
  entry: SupportedAcpAgentEntry
  installing: boolean
  onInstall: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">Install required</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {entry.agent.name} needs a local ACP binary before it can start chats.
        </p>
      </div>
      <Button type="button" size="sm" disabled={installing} onClick={onInstall}>
        {installing ? (
          <Loader2 size={14} className="mr-1.5 animate-spin" />
        ) : (
          <Download size={14} className="mr-1.5" />
        )}
        {installing ? 'Installing…' : 'Install'}
      </Button>
    </div>
  )
}

function AcpAgentPicker({
  agents,
  selectedEntry,
  selectedConfig,
  disabled,
  installingConfigId,
  onSelectAgent
}: {
  agents: readonly SupportedAcpAgentEntry[]
  selectedEntry: SupportedAcpAgentEntry | null
  selectedConfig: StoredAgentConfig | null
  disabled: boolean
  installingConfigId: string | null
  onSelectAgent: (entry: SupportedAcpAgentEntry) => void
}): React.JSX.Element {
  const rawLabel = selectedConfig?.name ?? selectedEntry?.agent.name ?? 'ACP Agent'
  const label = rawLabel.endsWith(' CLI') ? rawLabel.slice(0, -4) : rawLabel
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <ComposerPill
          disabled={disabled}
          aria-label={`Select ACP agent: ${label}`}
          className="max-w-[260px]"
          chevron
        >
          <EntryGlyph
            config={selectedConfig}
            templateId={selectedEntry?.agent.id}
            name={selectedEntry?.agent.name}
          />
          <span className="truncate">{label}</span>
        </ComposerPill>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-1">
        <div className="px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground/70">
          ACP Agent
        </div>
        {agents.map((entry) => (
          <button
            key={entry.configId}
            type="button"
            onClick={() => onSelectAgent(entry)}
            className={cn(
              'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
              entry.configId === selectedEntry?.configId && 'bg-accent/50'
            )}
          >
            <EntryGlyph config={entry.config} templateId={entry.agent.id} name={entry.agent.name} />
            <span className="min-w-0 flex-1 truncate">
              {entry.config?.name ?? entry.agent.name}
            </span>
            {entry.status === 'install-required' && (
              <span className="rounded bg-foreground/[0.08] px-1.5 py-0.5 text-3xs text-muted-foreground">
                {installingConfigId === entry.configId ? 'Installing…' : 'Install'}
              </span>
            )}
            {entry.status === 'unavailable' && (
              <span className="text-3xs text-muted-foreground">Unavailable</span>
            )}
            {entry.configId === selectedEntry?.configId && (
              <Check size={14} className="text-muted-foreground" />
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function AcpModelPicker({
  selectedEntry,
  modelOption,
  loading,
  errorMessage,
  disabled,
  onRetry,
  onSelectModel
}: {
  selectedEntry: SupportedAcpAgentEntry | null
  modelOption: ReturnType<typeof partitionConfigOptions>['model']
  loading: boolean
  errorMessage: string | null
  disabled: boolean
  onRetry: () => void
  onSelectModel: (valueId: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const currentModel = modelOption?.options.find((o) => o.value === modelOption.currentValue)
  const label = loading
    ? 'Loading model…'
    : errorMessage
      ? 'Model unavailable'
      : (currentModel?.name ?? 'Model')
  const showSearch = Boolean(modelOption && modelOption.options.length > 5)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredModels =
    modelOption?.options.filter((value) => {
      if (!normalizedQuery) return true
      return [value.name, value.value, value.description ?? '']
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    }) ?? []
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <ComposerPill
          disabled={disabled}
          aria-label={`Select model: ${label}`}
          className="max-w-[220px]"
          chevron
        >
          <span className="truncate">{label}</span>
        </ComposerPill>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-1">
        <div className="px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground/70">
          Model
        </div>
        {selectedEntry?.status !== 'ready' ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {selectedEntry?.status === 'install-required'
              ? 'Install this ACP agent to load model options.'
              : 'This ACP agent is not available on this platform.'}
          </div>
        ) : modelOption ? (
          <>
            {showSearch && (
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models..."
                aria-label="Search models"
                className="mb-1 w-full rounded-md bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary/40"
              />
            )}
            <div data-testid="acp-model-options" className="max-h-[180px] overflow-y-auto pr-1">
              {filteredModels.length > 0 ? (
                filteredModels.map((value) => (
                  <button
                    key={value.value}
                    type="button"
                    onClick={() => {
                      setQuery('')
                      onSelectModel(value.value)
                    }}
                    className={cn(
                      'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
                      value.value === modelOption.currentValue && 'bg-accent/50'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{value.name}</span>
                      {value.description && (
                        <span className="block text-xs text-muted-foreground">
                          {value.description}
                        </span>
                      )}
                    </span>
                    {value.value === modelOption.currentValue && (
                      <Check size={14} className="mt-0.5 text-muted-foreground" />
                    )}
                  </button>
                ))
              ) : (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No matching models.</div>
              )}
            </div>
          </>
        ) : errorMessage ? (
          <div className="space-y-2 px-2 py-1.5 text-xs text-muted-foreground">
            <div>
              <div className="font-medium text-foreground/85">Could not load model options.</div>
              <div className="mt-1 line-clamp-3 break-words">{errorMessage}</div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onRetry}
            >
              Retry
            </Button>
          </div>
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
  templateId,
  name,
  size = 'sm'
}: {
  config: StoredAgentConfig | null
  templateId?: string
  name?: string
  size?: 'sm' | 'lg'
}): React.JSX.Element {
  const normalized = useMemo(() => {
    const key = config?.templateId ?? templateId
    if (!key) return null
    const icon = findBundledIconByKey(`acp:${key}`)?.svg
    return icon ? sanitizeInlineAgentSvg(icon) : null
  }, [config?.templateId, templateId])
  const className =
    size === 'lg' ? 'h-12 w-12 rounded-2xl text-base' : 'h-4 w-4 rounded-sm text-4xs'

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
