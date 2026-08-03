import type { LastSelectedAgent } from '@shared/types/persistence.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { ArrowUp, Check, Download, FolderOpen, Loader2 } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  emptyPendingLauncherOptions,
  hasPendingLauncherOptions,
  overlayPendingLauncherOptions,
  type PendingLauncherOptions
} from '@/components/agents/pending-launcher-options'
import { ConfigChip, ModeChip } from '@/components/chat/AgentHeader'
import { AttachFilesButton } from '@/components/chat/AttachFilesButton'
import { AttachmentPreviewGroup } from '@/components/chat/AttachmentPreviewGroup'
import { CommandChip } from '@/components/chat/CommandChip'
import { ComposerPill } from '@/components/chat/ComposerPill'
import { attachmentToBlock } from '@/components/chat/chat-attachments'
import {
  extractFastModeOption,
  filterDuplicateModeConfigOptions,
  partitionConfigOptions,
  resolveModelOption
} from '@/components/chat/chat-input-bar-config'
import { FastModeToggle } from '@/components/chat/FastModeToggle'
import { FileMentionMenu } from '@/components/chat/FileMentionMenu'
import { McpBadge } from '@/components/chat/McpBadge'
import { SkillComposerOverlay } from '@/components/chat/SkillComposerOverlay'
import { SlashCommandMenu, type SlashMenuHandle } from '@/components/chat/SlashCommandMenu'
import { isSlashTriggerAny } from '@/components/chat/slash-menu-model'
import { useChatComposer } from '@/components/chat/use-chat-composer'
import { useComposerAttachments } from '@/components/chat/use-composer-attachments'
import { useComposerMentions } from '@/components/chat/use-composer-mentions'
import { useComposerTextarea } from '@/components/chat/use-composer-textarea'
import { useOptimisticSelect } from '@/components/chat/use-optimistic-select'
import { TermulMark } from '@/components/TermulMark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAcpRegistryCatalog } from '@/hooks/use-acp-registry-catalog'
import { useAcpRuntimeProbe } from '@/hooks/use-acp-runtime-probe'
import { useAgentSkills } from '@/hooks/use-agent-skills'
import { useMentionRecents } from '@/hooks/use-mention-recents'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  type AuthMethod,
  acpApi,
  type ContentBlock,
  type McpToolInfo,
  type ProbeStatus
} from '@/lib/acp-api'
import type { StoredMcpServer } from '@/lib/acp-mcp-persistence'
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
import { platform as osPlatform } from '@/lib/tauri-os'
import { cn } from '@/lib/utils'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import {
  type AcpSession,
  agentReuseKey,
  hasModelRelevantOptionsCache,
  prepareChatKey,
  useAcpSession,
  useAcpStore
} from '@/stores/acp-store'
import { useActiveProject, useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

interface AgentLauncherProps {
  paneId: string
  className?: string
}

const EMPTY_COMMANDS: [] = []
const EMPTY_AUTH_METHODS: AuthMethod[] = []
const EMPTY_MCP_SERVERS: StoredMcpServer[] = []
const EMPTY_PROBE_STATUS: Record<string, ProbeStatus> = {}
const EMPTY_MCP_TOOLS: Record<string, McpToolInfo[]> = {}

/** Survives overlay unmount so the new-thread picker does not flash the default. */
let cachedConfigId: string | null = null

/** Test-only: clear the cross-unmount selection cache. */
export function __resetLauncherSelectionCache(): void {
  cachedConfigId = null
}

export function AgentLauncher({ paneId, className }: AgentLauncherProps): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [selectedConfigId, setSelectedConfigId] = useState(() => cachedConfigId ?? '')
  const [installingConfigId, setInstallingConfigId] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')
  const [savingManualPath, setSavingManualPath] = useState(false)
  const [manualInstallOverride, setManualInstallOverride] =
    useState<SupportedAcpAgentManualInstall | null>(null)
  const [pendingOptions, setPendingOptions] = useState<PendingLauncherOptions>(
    emptyPendingLauncherOptions
  )
  const launchInFlightRef = useRef(false)
  const menuRef = useRef<SlashMenuHandle>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const acpConfigs = useAcpStore((s) => s.agentConfigs)
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const mcpServers = useAcpStore((s) => s.mcpServers) ?? EMPTY_MCP_SERVERS
  const mcpCount = mcpServers.length
  const setMcpServerEnabled = useAcpStore((s) => s.setMcpServerEnabled)
  const mcpProbeStatus = useAcpStore((s) => s.mcpProbeStatus) ?? EMPTY_PROBE_STATUS
  const mcpTools = useAcpStore((s) => s.mcpTools) ?? EMPTY_MCP_TOOLS
  const loadMcpTools = useAcpStore((s) => s.loadMcpTools)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProject = useActiveProject()
  const projectLabel = activeProject?.name ?? 'this folder'
  const projectRoot = activeProjectId ? getDefaultCwdForProject(activeProjectId) : undefined
  const { skills } = useAgentSkills(projectRoot)
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
  const [signingInMethodId, setSigningInMethodId] = useState<string | null>(null)
  const cachedOptions = useAcpStore((s) =>
    activeConfigId ? (s.agentOptionsCache[activeConfigId] ?? null) : null
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
    Boolean(installingConfigId) || savingManualPath || selectedEntry?.status !== 'ready'
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

  // Live session wins; otherwise paint last-known options (stale-while-revalidate),
  // then overlay any launcher selections made before the session is live.
  const baseConfigOptions = draftSession?.configOptions ?? cachedOptions?.configOptions ?? []
  const baseModels = draftSession?.models ?? cachedOptions?.models ?? null
  const baseModes = draftSession?.modes ?? cachedOptions?.modes ?? null
  const {
    models: effectiveModels,
    modes: effectiveModes,
    configOptions: effectiveConfigOptions
  } = useMemo(
    () =>
      overlayPendingLauncherOptions({
        models: baseModels,
        modes: baseModes,
        configOptions: baseConfigOptions,
        pending: pendingOptions
      }),
    [baseModels, baseModes, baseConfigOptions, pendingOptions]
  )
  const hasCachedModels = hasModelRelevantOptionsCache(cachedOptions)
  const hasCachedOptions = Boolean(cachedOptions)
  // Cached options are interactive immediately; never show connecting chrome on a cache hit.
  const optionsInteractive = Boolean(draftSession || hasCachedOptions)
  const showModelLoading = !prepareError && isPreparing && !draftSession && !hasCachedModels

  const usableConfigOptions = effectiveConfigOptions.filter((o) => o.options.length > 0)
  const {
    model,
    thoughtLevel,
    rest: genericConfigOptions
  } = partitionConfigOptions(usableConfigOptions)
  const { option: modelOption, source: modelSource } = resolveModelOption(model, effectiveModels)
  const visibleGenericConfigOptions = filterDuplicateModeConfigOptions(
    genericConfigOptions,
    effectiveModes
  )
  const { fastMode, rest: nonFastGenericOptions } = extractFastModeOption(
    visibleGenericConfigOptions
  )
  const modePreviewSession = useMemo((): AcpSession | null => {
    if (draftSession) return draftSession
    if (!effectiveModes) return null
    return {
      id: 'options-cache-preview',
      agentId: '',
      cwd: projectRoot ?? '',
      projectId: activeProjectId ?? '',
      status: 'initializing',
      title: null,
      activeTurn: false,
      openTurnId: null,
      modes: effectiveModes,
      models: effectiveModels,
      configOptions: effectiveConfigOptions,
      lastError: null,
      createdAt: cachedOptions?.updatedAt ?? 0
    }
  }, [
    draftSession,
    effectiveModes,
    projectRoot,
    activeProjectId,
    effectiveModels,
    effectiveConfigOptions,
    cachedOptions?.updatedAt
  ])
  // The three ACP setters below are declared before `useChatComposer` so the
  // shared hook can pass them as `onSetConfig`/`onSetMode`/`onSetModel` without
  // a temporal-dead-zone reference (the hook captures them at call time).
  const handleSetConfig = useCallback(
    async (configId: string, valueId: string) => {
      if (!preparedSessionId) {
        setPendingOptions((prev) => ({
          ...prev,
          configValues: { ...prev.configValues, [configId]: valueId }
        }))
        return
      }
      try {
        await useAcpStore.getState().setConfigOption(preparedSessionId, configId, valueId)
      } catch (err) {
        toast.error(`Failed to set option: ${String(err)}`)
        throw err
      }
    },
    [preparedSessionId]
  )

  const handleSetModel = useCallback(
    async (valueId: string) => {
      if (!preparedSessionId) {
        if (modelSource === 'models') {
          setPendingOptions((prev) => ({ ...prev, modelId: valueId }))
          return
        }
        if (!modelOption) {
          throw new Error('No model option is available for this session')
        }
        setPendingOptions((prev) => ({
          ...prev,
          modelId: valueId,
          configValues: { ...prev.configValues, [modelOption.id]: valueId }
        }))
        return
      }
      if (modelSource === 'models') {
        try {
          await useAcpStore.getState().setModel(preparedSessionId, valueId)
        } catch (err) {
          toast.error(`Failed to set model: ${String(err)}`)
          throw err
        }
        return
      }
      if (!modelOption) {
        throw new Error('No model option is available for this session')
      }
      await handleSetConfig(modelOption.id, valueId)
    },
    [handleSetConfig, modelOption, modelSource, preparedSessionId]
  )

  const handleSetMode = useCallback(
    async (modeId: string) => {
      if (!preparedSessionId) {
        setPendingOptions((prev) => ({ ...prev, modeId }))
        return
      }
      try {
        await useAcpStore.getState().setMode(preparedSessionId, modeId)
      } catch (err) {
        toast.error(`Failed to set agent: ${String(err)}`)
        throw err
      }
    },
    [preparedSessionId]
  )

  const slashOpen = isSlashTriggerAny(prompt) && !composerDisabled
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
    clampHeight,
    updateMentions
  } = useComposerTextarea({
    value: prompt,
    setValue: setPrompt,
    textareaRef,
    mentions,
    disabled: composerDisabled,
    slashOpen
  })

  const {
    slashSections,
    activeCommand,
    setActiveCommand,
    clearActiveCommand,
    skillPathsRef,
    hasSkillToken,
    handleSelect,
    handleKeyDown: composerHandleKeyDown,
    buildPromptParts
  } = useChatComposer({
    value: prompt,
    setValue: setPrompt,
    textareaRef,
    slashMenuRef: menuRef,
    commands,
    configOptions: optionsInteractive ? effectiveConfigOptions : [],
    modes: optionsInteractive ? effectiveModes : null,
    skills,
    disabled: composerDisabled,
    onSetConfig: handleSetConfig,
    onSetMode: handleSetMode,
    onSetModel: handleSetModel,
    modelOption,
    modelSource: modelSource ?? undefined,
    handleMentionKeyDown,
    updateMentions,
    resetMentions,
    resetHeight,
    clampHeight
  })

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
        // Retarget the app-level warm pool to this agent+cwd: drains stale
        // pooled sessions for other agents (same cwd) and seeds a warm session
        // for this one. The pool owns the session lifecycle, so — unlike the
        // old launcher-scoped prepareChat — we do NOT cancel on close (a warm
        // session stays ready for the next chat / a project switch-back).
        useAcpStore.getState().setSelectedAgentConfigId(activeConfigId)
        useAcpStore.getState().retargetWarmPool(activeConfigId, projectRoot, activeProjectId)
      } catch (err) {
        console.warn('[acp] failed to retarget warm pool for', activeConfigId, err)
      }
    })()
    return () => {
      cancelled = true
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
      setPendingOptions(emptyPendingLauncherOptions())
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

  const handleRetryPrepare = useCallback(() => {
    if (!activeConfigId || !projectRoot || !preparedKey) return
    const store = useAcpStore.getState()
    store.cancelPreparedChat(preparedKey)
    store.prepareChat(activeConfigId, projectRoot, undefined, activeProjectId)
  }, [activeConfigId, preparedKey, projectRoot, activeProjectId])

  // Run the agent-advertised authenticate for a chosen method, then re-prepare
  // so the session is created now that the provider login is complete. The
  // provider owns the login UX (often opening its own browser); Termul never
  // invents a redirect URL or stores credentials. Mirrors Zed's
  // ThreadState::Unauthenticated → authenticate → reset flow.
  const runAuthenticate = useCallback(
    async (methodId: string) => {
      if (!liveAgentId) {
        toast.error('Agent is not connected. Use Retry to reconnect, then sign in again.')
        return
      }
      if (signingInMethodId) return
      setSigningInMethodId(methodId)
      try {
        await useAcpStore.getState().authenticateAgent(liveAgentId, methodId)
        handleRetryPrepare()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Sign-in failed')
      } finally {
        setSigningInMethodId(null)
      }
    },
    [liveAgentId, signingInMethodId, handleRetryPrepare]
  )

  const handleSignIn = useCallback(() => {
    if (!signInMethod) {
      toast.error('No sign-in method is available for this agent yet.')
      return
    }
    void runAuthenticate(signInMethod.id)
  }, [signInMethod, runAuthenticate])

  // If prepare finishes while the launcher is still open, flush queued selections.
  useEffect(() => {
    if (!preparedSessionId || !hasPendingLauncherOptions(pendingOptions)) return
    let cancelled = false
    const snapshot = pendingOptions
    void (async () => {
      try {
        await useAcpStore.getState().applyPendingLauncherOptions(preparedSessionId, snapshot)
        if (!cancelled) setPendingOptions(emptyPendingLauncherOptions())
      } catch (err) {
        if (!cancelled) {
          toast.error(`Failed to apply options: ${String(err)}`)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // Flush once when a prepared session appears; pending is snapshotted above.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [preparedSessionId, pendingOptions])

  const launch = useCallback(async () => {
    if (!activeProjectId || !projectRoot) {
      toast.error('No active project')
      return
    }
    if (!selectedConfig || selectedEntry?.status !== 'ready' || launchInFlightRef.current) return

    launchInFlightRef.current = true
    const pendingSnapshot = pendingOptions
    const attachmentsSnapshot = [...attachments]
    const appOwnedPaths = appOwnedTempPaths()
    const modelsSnapshot = effectiveModels
    const modesSnapshot = effectiveModes
    const configOptionsSnapshot = effectiveConfigOptions
    const preparedKeySnapshot = preparedKey
    const configSnapshot = selectedConfig
    const paneSnapshot = paneId
    const projectIdSnapshot = activeProjectId
    const projectRootSnapshot = projectRoot
    const needsSave = !acpConfigs.some((config) => config.id === selectedConfig.id)

    // Build the wire text (skills framed by path under `# Agent Skills`, then
    // the user text with tokens replaced by `(name)`) and the display text (the
    // raw token value, so the chat timeline re-renders inline chips), with the
    // active command prefixed to both. Shared with `ChatInputBar.submit` via
    // `useChatComposer.buildPromptParts` so the two surfaces cannot drift. A
    // skill surfaced without a path (web parity gap) blocks the launch —
    // `buildPromptParts` throws and the catch toasts + releases the in-flight
    // flag before any session is claimed/created.
    let parts: ReturnType<typeof buildPromptParts>
    try {
      parts = buildPromptParts()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start agent chat')
      launchInFlightRef.current = false
      return
    }
    const { wireWithCommand, displayWithCommand } = parts

    // Open the chat immediately; ACP spawn/session/send continue in the chat view.
    const store = useAcpStore.getState()
    let sessionId =
      preparedKeySnapshot != null
        ? store.claimPreparedChat(preparedKeySnapshot, projectIdSnapshot)
        : null
    let usedPlaceholder = false
    let seededOptimistic = false

    // Sync first-turn content so the chat can paint like a normal send. The
    // optimistic syncBlocks carry the DISPLAY (token) text so the timeline
    // renders inline chips; the real send dispatches the WIRE text.
    const syncTrimmed = displayWithCommand.trim()
    const syncBlocks: ContentBlock[] = []
    if (attachmentsSnapshot.length > 0) {
      if (syncTrimmed) syncBlocks.push({ type: 'text', text: displayWithCommand })
      for (const a of attachmentsSnapshot) syncBlocks.push(attachmentToBlock(a))
    } else if (syncTrimmed.length > 0) {
      syncBlocks.push({ type: 'text', text: displayWithCommand })
    }

    if (!sessionId) {
      sessionId = store.createLaunchPlaceholder({
        cwd: projectRootSnapshot,
        projectId: projectIdSnapshot,
        models: modelsSnapshot,
        modes: modesSnapshot,
        configOptions: configOptionsSnapshot,
        initialUserBlocks: syncBlocks.length > 0 ? syncBlocks : undefined
      })
      usedPlaceholder = true
      seededOptimistic = syncBlocks.length > 0
    } else if (syncBlocks.length > 0) {
      store.seedLaunchUserMessage(sessionId, syncBlocks)
      seededOptimistic = true
    }
    useWorkspaceStore.getState().addAgentChatTab(sessionId, paneSnapshot)
    useWorkspaceStore.getState().hideAgentLauncher()
    setPendingOptions(emptyPendingLauncherOptions())
    skillPathsRef.current = {}
    setActiveCommand(null)
    clearAttachments()
    resetMentions()
    resetHeight()
    setPrompt('')

    void (async () => {
      try {
        if (needsSave) {
          await saveAgentConfig(configSnapshot)
        }
        persistSelection(configSnapshot.id)

        // Real send carries the WIRE text (path-framed skills, command-prefixed)
        // so the agent receives paths, not tokens.
        const wireTrimmed = wireWithCommand.trim()
        const blocks: ContentBlock[] = []
        if (attachmentsSnapshot.length > 0) {
          if (wireTrimmed) blocks.push({ type: 'text', text: wireWithCommand })
          for (const a of attachmentsSnapshot) blocks.push(attachmentToBlock(a))
        } else if (wireTrimmed.length > 0) {
          blocks.push({ type: 'text', text: wireWithCommand })
        }

        const liveStore = useAcpStore.getState()
        let realId = sessionId
        if (usedPlaceholder) {
          realId = await liveStore.finalizeChatLaunch({
            placeholderId: sessionId,
            configId: configSnapshot.id,
            cwd: projectRootSnapshot,
            projectId: projectIdSnapshot,
            mcpServers: undefined,
            pending: hasPendingLauncherOptions(pendingSnapshot) ? pendingSnapshot : null,
            initialText: null,
            initialBlocks: blocks.length > 0 ? blocks : null,
            adoptSession: (from, to) => {
              useWorkspaceStore.getState().remapAgentChatSession(from, to, paneSnapshot)
            }
          })
        } else {
          await liveStore.applyPendingLauncherOptions(
            realId,
            hasPendingLauncherOptions(pendingSnapshot) ? pendingSnapshot : null
          )
          if (blocks.length > 0) {
            await liveStore.sendPromptBlocks(realId, blocks, {
              skipUserAppend: seededOptimistic
            })
          }
          liveStore.clearLaunchingSession(realId)
        }
        registerSessionTempFiles(realId, appOwnedPaths)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to start agent chat')
      } finally {
        launchInFlightRef.current = false
      }
    })()
  }, [
    activeProjectId,
    projectRoot,
    selectedConfig,
    selectedEntry?.status,
    acpConfigs,
    saveAgentConfig,
    persistSelection,
    paneId,
    attachments,
    clearAttachments,
    appOwnedTempPaths,
    resetMentions,
    resetHeight,
    pendingOptions,
    preparedKey,
    effectiveModels,
    effectiveModes,
    effectiveConfigOptions,
    buildPromptParts,
    skillPathsRef,
    setActiveCommand
  ])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Shared composer dispatch (skill-token backspace, slash-menu keys,
      // mention-menu keys) lives in `useChatComposer`. Enter→launch and
      // Escape→hide are surface-specific (the launcher dispatches a chat
      // launch, not a running-turn send) and run only when the shared
      // handler did not consume the event. Both the slash and mention menus
      // call `preventDefault` on Escape/Enter, so `e.defaultPrevented` is the
      // single reliable gate.
      composerHandleKeyDown(e)
      if (e.defaultPrevented) return
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        void launch()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void launch()
      }
      if (e.key === 'Escape') {
        useWorkspaceStore.getState().hideAgentLauncher()
      }
    },
    [composerHandleKeyDown, launch]
  )

  const canLaunch =
    Boolean(selectedConfig) &&
    selectedEntry?.status === 'ready' &&
    (prompt.trim().length > 0 || attachments.length > 0 || activeCommand !== null)
  // `hasSkillToken` comes from `useChatComposer` (destructured above) — the
  // transparent-textarea overlay is only needed when the value carries a skill
  // token; otherwise the textarea text stays visible.

  return (
    <div
      className={cn('absolute inset-0 flex flex-col items-center justify-center p-8', className)}
    >
      <div className="mb-8 flex flex-col items-center gap-4 text-center">
        <TermulMark size={48} className="text-foreground" />
        <h1 className="text-3xl font-medium tracking-tight text-foreground md:text-4xl">
          {`What should we do in ${projectLabel}?`}
        </h1>
      </div>

      <div className="flex w-full max-w-4xl flex-col gap-4">
        <div className="relative">
          {slashOpen && (
            <SlashCommandMenu
              ref={menuRef}
              sections={slashSections}
              onSelect={handleSelect}
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
            {prepareError &&
              (prepareError.category === 'auth' || prepareError.category === 'multi-auth') && (
                <AuthRequiredBanner
                  agentName={selectedEntry?.agent.name ?? 'Agent'}
                  setupError={prepareError}
                  authMethods={authMethods}
                  signingInMethodId={signingInMethodId}
                  onAuthenticate={(methodId) => void runAuthenticate(methodId)}
                  onRetry={handleRetryPrepare}
                />
              )}
            {activeCommand && <CommandChip name={activeCommand} onRemove={clearActiveCommand} />}
            <AttachmentPreviewGroup
              attachments={attachments}
              onRemove={removeAttachment}
              className="px-5 pt-4"
            />
            <div className="px-5 pb-2 pt-4">
              {/* Transparent-textarea overlay: mirrors the value with inline
                  SkillChip pills. The textarea text is transparent with a
                  visible caret; this overlay renders the visible text + chips
                  in the same metrics so the caret stays aligned.

                  The overlay is `absolute inset-0`, so its containing block
                  must be a box that exactly matches the textarea — not the
                  padded parent (which would shift the overlay up-left by the
                  parent's padding and paint chips above the caret). The inner
                  `relative` wrapper has no padding, so its box == the
                  textarea's box and the overlay stays caret-aligned. */}
              <div className="relative">
                <SkillComposerOverlay textareaRef={textareaRef} value={prompt} />
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={onInput}
                  onKeyDown={handleKeyDown}
                  onKeyUp={onKeyUp}
                  onSelect={onSelect}
                  onPaste={handlePaste}
                  placeholder="Ask for follow-up changes or attach files (@ for files, / for commands)"
                  rows={2}
                  aria-label="Agent prompt"
                  autoFocus
                  className={cn(
                    'relative z-10 max-h-40 min-h-[76px] w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground/55',
                    hasSkillToken ? 'text-transparent caret-foreground' : 'text-foreground'
                  )}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 px-3 pb-3">
              <div className="flex min-w-0 items-center gap-2">
                <AttachFilesButton onClick={() => void pickFiles()} disabled={!canPick} />
                <McpBadge
                  count={mcpCount}
                  servers={mcpServers}
                  onToggle={(id, enabled) => {
                    void setMcpServerEnabled(id, enabled)
                      .then(() => {
                        // The launcher pre-warms a `session/new` keyed without
                        // MCP servers; createSession resolved the MCP set from
                        // the registry AT pre-warm time. A toggle changes that
                        // registry, so the warm session now holds a stale MCP
                        // selection. Cancel + re-prepare so the next launch
                        // resolves MCP from the updated registry.
                        if (!preparedKey || !activeConfigId || !projectRoot) return
                        const store = useAcpStore.getState()
                        store.cancelPreparedChat(preparedKey)
                        store.prepareChat(activeConfigId, projectRoot, undefined, activeProjectId)
                      })
                      .catch(() => {
                        toast.error(
                          'Could not update the MCP server. Your previous setting was restored.'
                        )
                      })
                  }}
                  probeStatus={mcpProbeStatus}
                  tools={mcpTools}
                  onLoadTools={(id) => {
                    void loadMcpTools(id)
                  }}
                />
              </div>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2.5">
                <AcpAgentPicker
                  agents={supportedAgents}
                  selectedEntry={selectedEntry}
                  selectedConfig={selectedConfig}
                  disabled={Boolean(installingConfigId) || savingManualPath}
                  installingConfigId={installingConfigId}
                  onSelectAgent={handleSelectAgent}
                />
                <AcpModelPicker
                  selectedEntry={selectedEntry}
                  modelOption={modelOption}
                  loading={showModelLoading}
                  connecting={false}
                  stale={Boolean(prepareError && hasCachedModels)}
                  setupError={prepareError}
                  signInMethod={signInMethod}
                  onSignIn={() => void handleSignIn()}
                  disabled={
                    Boolean(installingConfigId) ||
                    savingManualPath ||
                    (!optionsInteractive && !prepareError)
                  }
                  onRetry={handleRetryPrepare}
                  onSelectModel={handleSetModel}
                />
                {thoughtLevel && (
                  <ConfigChip
                    option={thoughtLevel}
                    disabled={!optionsInteractive}
                    promoted
                    onSelect={(valueId) => void handleSetConfig(thoughtLevel.id, valueId)}
                  />
                )}
                {fastMode && (
                  <FastModeToggle
                    option={fastMode}
                    disabled={!optionsInteractive}
                    onSelect={(valueId) => void handleSetConfig(fastMode.id, valueId)}
                  />
                )}
                {nonFastGenericOptions.map((option) => (
                  <ConfigChip
                    key={option.id}
                    option={option}
                    disabled={!optionsInteractive}
                    onSelect={(valueId) => void handleSetConfig(option.id, valueId)}
                  />
                ))}
                {modePreviewSession && (
                  <ModeChip
                    session={modePreviewSession}
                    disabled={!optionsInteractive}
                    onSelect={handleSetMode}
                    label="Agent"
                  />
                )}
                <button
                  type="button"
                  onClick={() => launch()}
                  disabled={!canLaunch}
                  className={cn(
                    'flex size-[34px] shrink-0 items-center justify-center rounded-lg transition-colors',
                    canLaunch
                      ? 'bg-foreground text-background hover:bg-foreground/90'
                      : 'cursor-not-allowed bg-muted text-muted-foreground'
                  )}
                  aria-label="Start agent chat"
                  title="Start agent chat"
                >
                  <ArrowUp size={18} />
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
                setActiveCommand(null)
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

/** Zed-style auth callout: visible without opening the model picker popover. */
function AuthRequiredBanner({
  agentName,
  setupError,
  authMethods,
  signingInMethodId,
  onAuthenticate,
  onRetry
}: {
  agentName: string
  setupError: PrepareChatError
  authMethods: AuthMethod[]
  signingInMethodId: string | null
  onAuthenticate: (methodId: string) => void
  onRetry: () => void
}): React.JSX.Element {
  const signingInMethod = authMethods.find((m) => m.id === signingInMethodId)
  const actionableMethods = authMethods.filter((m) => m.id.trim().length > 0)

  return (
    <div className="border-b border-border/60 px-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground">
            {signingInMethod ? `Authenticating to ${agentName}…` : `Authenticate to ${agentName}`}
          </div>
          <p className="mt-0.5 line-clamp-4 break-words text-xs text-muted-foreground">
            {setupError.detail}
          </p>
          {setupError.category === 'multi-auth' && actionableMethods.length > 1 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Choose one of the following authentication options:
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {signingInMethod ? (
            <Button type="button" size="sm" disabled>
              <Loader2 size={14} className="mr-1.5 animate-spin" />
              {`Signing in with ${signingInMethod.name}…`}
            </Button>
          ) : actionableMethods.length > 0 ? (
            actionableMethods.map((method, index) => (
              <Button
                key={method.id}
                type="button"
                size="sm"
                variant={index === actionableMethods.length - 1 ? 'default' : 'outline'}
                title={method.description ?? undefined}
                onClick={() => onAuthenticate(method.id)}
              >
                {method.name}
              </Button>
            ))
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          )}
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <ComposerPill
          disabled={disabled}
          aria-label={`Select model: ${label}`}
          className={cn('max-w-[220px]', (connecting || stale) && !setupError && 'opacity-80')}
          chevron
          pending={pending || (connecting && !setupError)}
        >
          <span className="truncate">{label}</span>
        </ComposerPill>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-1">
        <div className="px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground/70">
          Model
          {connecting && !setupError && (
            <span className="ml-1 font-normal normal-case tracking-normal">· Connecting…</span>
          )}
          {stale && !connecting && !setupError && (
            <span className="ml-1 font-normal normal-case tracking-normal">· Cached</span>
          )}
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
        ) : !setupError && modelOption ? (
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
                    onPointerDown={(event) => {
                      if ((event.button ?? 0) !== 0) return
                      event.preventDefault()
                      handleSelectModel(value.value)
                    }}
                    onClick={() => handleSelectModel(value.value)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                      value.value === displayValue && 'bg-accent text-accent-foreground'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{value.name}</span>
                      {value.description && (
                        <span className="block text-xs opacity-70">{value.description}</span>
                      )}
                    </span>
                    {value.value === displayValue && (
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
  name
}: {
  config: StoredAgentConfig | null
  templateId?: string
  name?: string
}): React.JSX.Element {
  const normalized = useMemo(() => {
    const key = config?.templateId ?? templateId
    if (!key) return null
    const icon = findBundledIconByKey(`acp:${key}`)?.svg
    return icon ? sanitizeInlineAgentSvg(icon) : null
  }, [config?.templateId, templateId])
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
