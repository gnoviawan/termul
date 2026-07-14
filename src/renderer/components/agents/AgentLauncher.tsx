import type { LastSelectedAgent } from '@shared/types/persistence.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { platform as osPlatform } from '@tauri-apps/plugin-os'
import { ArrowUp, Check, Download, FolderOpen, Loader2, Paperclip } from 'lucide-react'
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
import { FileMentionMenu } from '@/components/chat/FileMentionMenu'
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
import { useComposerMentions } from '@/components/chat/use-composer-mentions'
import { useComposerTextarea } from '@/components/chat/use-composer-textarea'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAcpRegistryCatalog } from '@/hooks/use-acp-registry-catalog'
import { useAcpRuntimeProbe } from '@/hooks/use-acp-runtime-probe'
import {
  buildPromptWithLoadedSkill,
  type LoadedAgentSkill,
  useAgentSkills
} from '@/hooks/use-agent-skills'
import { useMentionRecents } from '@/hooks/use-mention-recents'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { type AuthMethod, acpApi, type ContentBlock } from '@/lib/acp-api'
import { currentPlatformArch } from '@/lib/agents/acp-registry'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import {
  buildSupportedAcpAgents,
  filterSupportedAcpAgents,
  installedBinaryConfig,
  manualBinaryConfig,
  pickDefaultSupportedAgent,
  type SupportedAcpAgentEntry,
  type SupportedAcpAgentManualInstall
} from '@/lib/agents/supported-acp-agents'
import { dialogApi, openerApi, persistenceApi } from '@/lib/api'
import { registerSessionTempFiles } from '@/lib/attachment-temp-cleanup'
import { cn } from '@/lib/utils'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { agentReuseKey, prepareChatKey, useAcpSession, useAcpStore } from '@/stores/acp-store'
import { useActiveProject, useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

interface AgentLauncherProps {
  paneId: string
  className?: string
}

const EMPTY_COMMANDS: [] = []
const EMPTY_AUTH_METHODS: AuthMethod[] = []

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
  const [manualPath, setManualPath] = useState('')
  const [savingManualPath, setSavingManualPath] = useState(false)
  const [manualInstallOverride, setManualInstallOverride] =
    useState<SupportedAcpAgentManualInstall | null>(null)
  const menuRef = useRef<SlashMenuHandle>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const acpConfigs = useAcpStore((s) => s.agentConfigs)
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProject = useActiveProject()
  const projectLabel = activeProject?.name ?? 'this folder'
  const projectRoot = activeProjectId ? getDefaultCwdForProject(activeProjectId) : undefined
  const platformArch = useMemo(() => currentPlatformArch(), [])
  const runtime = useAcpRuntimeProbe()
  const { activeRegistry } = useAcpRegistryCatalog()
  const supportedAgents = useMemo(
    () => buildSupportedAcpAgents(acpConfigs, platformArch, activeRegistry, runtime),
    [acpConfigs, platformArch, activeRegistry, runtime]
  )

  const selectedEntry = useMemo(
    () =>
      supportedAgents.find((entry) => entry.configId === selectedConfigId) ??
      pickDefaultSupportedAgent(supportedAgents) ??
      supportedAgents[0] ??
      null,
    [supportedAgents, selectedConfigId]
  )
  const manualInstallContext =
    selectedEntry?.manualInstall ??
    (selectedEntry?.status === 'install-required' ? manualInstallOverride : null)
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
  // Resolve the live agent for this config+cwd so an auth failure can offer a
  // Sign-in action driven by the agent's advertised method metadata. A Sign-in
  // button is only meaningful when exactly one method is advertised (P6).
  const reuseKey = activeConfigId && projectRoot ? agentReuseKey(activeConfigId, projectRoot) : null
  const liveAgentId = useAcpStore((s) =>
    reuseKey ? (s.configToLiveAgent?.[reuseKey] ?? null) : null
  )
  const authMethods = useAcpStore((s) =>
    liveAgentId ? (s.agents?.[liveAgentId]?.authMethods ?? EMPTY_AUTH_METHODS) : EMPTY_AUTH_METHODS
  )
  const signInMethod = authMethods.length === 1 ? authMethods[0] : null
  const draftSession = useAcpSession(preparedSessionId)
  const promptCaps = useAcpStore((s) =>
    draftSession?.agentId
      ? s.agents?.[draftSession.agentId]?.capabilities?.promptCapabilities
      : undefined
  )
  const imageCapable = Boolean(promptCaps?.image)
  const embedCapable = Boolean(promptCaps?.embeddedContext)
  const composerDisabled =
    isLaunching ||
    Boolean(installingConfigId) ||
    savingManualPath ||
    selectedEntry?.status !== 'ready'
  const {
    attachments,
    addFiles,
    pickFiles,
    addFileRef,
    handlePaste,
    removeAttachment,
    clearAttachments,
    appOwnedTempPaths,
    canPick,
    canDropPaste
  } = useComposerAttachments({ imageCapable, embedCapable, disabled: composerDisabled })
  const { recents: mentionRecents, pushRecent: pushMentionRecent } = useMentionRecents(
    activeProjectId,
    projectRoot
  )
  const mentions = useComposerMentions({
    rootPath: projectRoot,
    disabled: composerDisabled,
    recents: mentionRecents,
    onStageFileRef: (m) => {
      addFileRef(m)
      pushMentionRecent(m)
    }
  })
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
  const {
    onInput,
    onKeyUp,
    onSelect,
    onMentionSelect,
    handleMentionKeyDown,
    mentionMenuOpen,
    mentionSections,
    mentionMenuRef,
    emptyLabel,
    resetMentions,
    resetHeight,
    updateMentions
  } = useComposerTextarea({
    value: prompt,
    setValue: setPrompt,
    textareaRef,
    mentions,
    disabled: composerDisabled,
    slashOpen: menuOpen
  })
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
        const next = restored ?? pickDefaultSupportedAgent(supportedAgents) ?? supportedAgents[0]
        if (next) {
          setSelectedConfigId(next.configId)
          persistSelection(next.configId)
        }
      } catch {
        const next = pickDefaultSupportedAgent(supportedAgents) ?? supportedAgents[0]
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
      setManualPath('')
      setManualInstallOverride(null)
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
        setManualInstallOverride({
          cmd: entry.install.cmd,
          args: entry.install.args,
          env: entry.install.env
        })
      } finally {
        setInstallingConfigId(null)
      }
    },
    [installingConfigId, persistSelection, saveAgentConfig]
  )

  const handleBrowseManualPath = useCallback(async () => {
    const result = await dialogApi.selectFile({
      title: 'Select ACP agent executable',
      filters:
        osPlatform() === 'windows' ? [{ name: 'Executable', extensions: ['exe'] }] : undefined
    })
    if (result.success && result.data) {
      setManualPath(result.data)
    }
  }, [])

  const handleSaveManualPath = useCallback(
    async (entry: SupportedAcpAgentEntry, manual: SupportedAcpAgentManualInstall) => {
      if (savingManualPath) return
      const command = manualPath.trim()
      if (!command) {
        toast.error('Enter the path to the installed ACP binary.')
        return
      }
      setSelectedConfigId(entry.configId)
      persistSelection(entry.configId)
      setSavingManualPath(true)
      try {
        const config = manualBinaryConfig(entry.agent, command, manual)
        await saveAgentConfig(config)
        setSelectedConfigId(config.id)
        persistSelection(config.id)
        toast.success(`${entry.agent.name} configured`)
      } catch (err) {
        toast.error(`Failed to save ${entry.agent.name}: ${String(err)}`)
      } finally {
        setSavingManualPath(false)
      }
    },
    [manualPath, persistSelection, saveAgentConfig, savingManualPath]
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

  // Run the agent-advertised authenticate for the single method, then re-prepare
  // so the session is created now that the provider login is complete. The
  // provider owns the login UX (often opening its own browser); Termul never
  // invents a redirect URL or stores credentials.
  const handleSignIn = useCallback(async () => {
    if (!liveAgentId || !signInMethod) return
    try {
      await useAcpStore.getState().authenticateAgent(liveAgentId, signInMethod.id)
      handleRetryPrepare()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sign-in failed')
    }
  }, [liveAgentId, signInMethod, handleRetryPrepare])

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
        updateMentions('', 0)
        resetHeight()
        textareaRef.current?.focus()
        return
      }
      if (item.kind === 'config') {
        handleSetConfig(item.configId, item.valueId)
      } else if (item.kind === 'mode') {
        handleSetMode(item.modeId)
      } else if (item.kind === 'command') {
        const next = `/${item.name} `
        setPrompt(next)
        updateMentions(next, next.length)
        textareaRef.current?.focus()
        return
      }
      setPrompt('')
      updateMentions('', 0)
      resetHeight()
    },
    [handleSetConfig, handleSetMode, updateMentions, resetHeight]
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
        // Await the initial send so a first-turn rejection is caught by this
        // try/catch and the composed text/attachments are preserved on failure
        // (the state reset below only runs once the send resolves).
        await useAcpStore.getState().sendPromptBlocks(sessionId, blocks)
      } else if (trimmed.length > 0) {
        await useAcpStore.getState().sendPrompt(sessionId, trimmed)
      }
      // Register app-owned temp files (pasted screenshots) with the session so
      // they are deleted when the session closes; clearAttachments drops state
      // without deleting because the agent reads them by path during the turn.
      registerSessionTempFiles(sessionId, appOwnedTempPaths())
      setLoadedSkill(null)
      clearAttachments()
      resetMentions()
      resetHeight()
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
    clearAttachments,
    appOwnedTempPaths,
    resetMentions,
    resetHeight
  ])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        tryHandleSlashMenuKeyDown(e, {
          menuOpen,
          sectionsLength: slashSections.length,
          menuRef,
          onClearInput: () => {
            setPrompt('')
            updateMentions('', 0)
            resetHeight()
          }
        })
      ) {
        return
      }
      if (handleMentionKeyDown(e)) {
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
    [launch, menuOpen, slashSections.length, handleMentionKeyDown, updateMentions, resetHeight]
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
            <SlashCommandMenu
              ref={menuRef}
              sections={slashSections}
              onSelect={handleSlashSelect}
              inputRef={textareaRef}
            />
          )}
          {mentionMenuOpen && (
            <FileMentionMenu
              ref={mentionMenuRef}
              sections={mentionSections}
              onSelect={onMentionSelect}
              emptyLabel={emptyLabel}
              inputRef={textareaRef}
            />
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
            {selectedEntry?.status === 'install-required' && !manualInstallContext && (
              <InstallRequiredBanner
                entry={selectedEntry}
                installing={installingConfigId === selectedEntry.configId}
                onInstall={() => void handleInstallAgent(selectedEntry)}
                onUseCustomPath={
                  selectedEntry.install
                    ? () =>
                        setManualInstallOverride({
                          cmd: selectedEntry.install!.cmd,
                          args: selectedEntry.install!.args,
                          env: selectedEntry.install!.env
                        })
                    : undefined
                }
              />
            )}
            {manualInstallContext && selectedEntry && (
              <ManualInstallBanner
                entry={selectedEntry}
                manual={manualInstallContext}
                path={manualPath}
                saving={savingManualPath}
                onPathChange={setManualPath}
                onBrowse={() => void handleBrowseManualPath()}
                onSave={() => void handleSaveManualPath(selectedEntry, manualInstallContext)}
              />
            )}
            {selectedEntry?.status === 'needs-runtime' && (
              <NeedsRuntimeBanner entry={selectedEntry} />
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
                onChange={onInput}
                onKeyDown={handleKeyDown}
                onKeyUp={onKeyUp}
                onSelect={onSelect}
                onPaste={handlePaste}
                placeholder={
                  loadedSkill
                    ? 'Add a message (optional)…'
                    : 'Ask for follow-up changes or attach files (@ for files, / for commands)'
                }
                rows={2}
                aria-label="Agent prompt"
                autoFocus
                className="max-h-40 min-h-[76px] w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground/55"
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
                  disabled={isLaunching || Boolean(installingConfigId) || savingManualPath}
                  installingConfigId={installingConfigId}
                  onSelectAgent={handleSelectAgent}
                />
                <AcpModelPicker
                  selectedEntry={selectedEntry}
                  modelOption={modelOption}
                  loading={!prepareError && isPreparing && !draftSession}
                  setupError={prepareError}
                  signInMethod={signInMethod}
                  onSignIn={() => void handleSignIn()}
                  disabled={isLaunching || Boolean(installingConfigId) || savingManualPath}
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
                updateMentions(suggestion.prompt, suggestion.prompt.length)
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
  onInstall,
  onUseCustomPath
}: {
  entry: SupportedAcpAgentEntry
  installing: boolean
  onInstall: () => void
  onUseCustomPath?: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">Install required</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {entry.agent.name} needs a local ACP binary before it can start chats.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onUseCustomPath && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={installing}
            onClick={onUseCustomPath}
          >
            Custom path
          </Button>
        )}
        <Button type="button" size="sm" disabled={installing} onClick={onInstall}>
          {installing ? (
            <Loader2 size={14} className="mr-1.5 animate-spin" />
          ) : (
            <Download size={14} className="mr-1.5" />
          )}
          {installing ? 'Installing…' : 'Install'}
        </Button>
      </div>
    </div>
  )
}

const RUNTIME_HELP_URLS = {
  npx: 'https://nodejs.org/en/download',
  uvx: 'https://docs.astral.sh/uv/getting-started/installation/'
} as const

function NeedsRuntimeBanner({ entry }: { entry: SupportedAcpAgentEntry }): React.JSX.Element {
  const launcher = entry.runtimeLauncher ?? 'npx'
  const helpUrl = RUNTIME_HELP_URLS[launcher]
  const helpLabel = launcher === 'uvx' ? 'Install uv' : 'Install Node.js'

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">Runtime required</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{entry.unavailableReason}</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void openerApi.openUrlWithSystemBrowser(helpUrl)}
      >
        {helpLabel}
      </Button>
    </div>
  )
}

function ManualInstallBanner({
  entry,
  manual,
  path,
  saving,
  onPathChange,
  onBrowse,
  onSave
}: {
  entry: SupportedAcpAgentEntry
  manual: SupportedAcpAgentManualInstall
  path: string
  saving: boolean
  onPathChange: (value: string) => void
  onBrowse: () => void
  onSave: () => void
}): React.JSX.Element {
  const expectedCommand = `${manual.cmd}${manual.args.length > 0 ? ` ${manual.args.join(' ')}` : ''}`

  return (
    <div className="space-y-3 border-b border-border/60 px-5 py-3">
      <div>
        <div className="text-xs font-medium text-foreground">Manual install</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {entry.unavailableReason ??
            `Install ${entry.agent.name} from the vendor, then point Termul at the binary.`}
        </p>
        {expectedCommand && (
          <p className="mt-1 font-mono text-2xs text-muted-foreground">
            Expected: {expectedCommand}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={path}
          onChange={(event) => onPathChange(event.target.value)}
          placeholder="Path to installed ACP binary"
          aria-label="ACP agent executable path"
          className="h-8 font-mono text-xs"
          disabled={saving}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={onBrowse}
          aria-label="Browse for ACP agent executable"
        >
          <FolderOpen size={14} />
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saving || path.trim().length === 0}
          onClick={onSave}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
        </Button>
      </div>
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
  const [query, setQuery] = useState('')
  const visibleAgents = useMemo(() => filterSupportedAcpAgents(agents, query), [agents, query])
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
        <div className="px-2 pb-1">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agents…"
            aria-label="Search ACP agents"
            className="h-7 text-xs"
          />
        </div>
        <div className="max-h-64 overflow-y-auto pr-1">
          {visibleAgents.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">No agents match.</div>
          ) : (
            visibleAgents.map((entry) => (
              <button
                key={entry.configId}
                type="button"
                onClick={() => onSelectAgent(entry)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
                  entry.configId === selectedEntry?.configId && 'bg-accent/50'
                )}
              >
                <EntryGlyph
                  config={entry.config}
                  templateId={entry.agent.id}
                  name={entry.agent.name}
                />
                <span className="min-w-0 flex-1 truncate">
                  {entry.config?.name ?? entry.agent.name}
                </span>
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
                {entry.configId === selectedEntry?.configId && (
                  <Check size={14} className="text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function AcpModelPicker({
  selectedEntry,
  modelOption,
  loading,
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
  setupError: PrepareChatError | null
  signInMethod: AuthMethod | null
  onSignIn: () => void
  disabled: boolean
  onRetry: () => void
  onSelectModel: (valueId: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const currentModel = modelOption?.options.find((o) => o.value === modelOption.currentValue)
  // Category-specific label so only a genuine empty-model state reads as a
  // neutral "Model" pill — setup failures get an actionable label instead of a
  // misleading "Model unavailable".
  const label = loading
    ? 'Loading model…'
    : setupError
      ? setupError.label
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
              : selectedEntry?.status === 'needs-runtime'
                ? 'Install the required runtime before loading model options.'
                : selectedEntry?.status === 'manual-install'
                  ? 'Install this agent manually before loading model options.'
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
