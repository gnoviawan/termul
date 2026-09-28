import type { LastSelectedAgent, PersistedComposerOptions } from '@shared/types/persistence.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import type { Editor } from '@tiptap/core'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { AgentUpdateCta, useSelectedAgentUpdate } from '@/components/agents/launcher/AgentUpdateCta'
import {
  AuthRequiredBanner,
  InstallRequiredBanner,
  ManualInstallBanner,
  NeedsRuntimeBanner,
  NonAuthFailureBanner
} from '@/components/agents/launcher/banners'
import {
  FactoryApiKeyForm,
  useFactoryKeyAuth
} from '@/components/agents/launcher/FactoryApiKeyForm'
import {
  STRIP_MENU_ITEM_CLASS,
  STRIP_TRIGGER_CLASS
} from '@/components/agents/launcher/launcher-classes'
import { AcpAgentPicker, AcpModelPicker } from '@/components/agents/launcher/pickers'
import { spawnAcpLoginTerminal } from '@/components/agents/launcher/spawn-acp-login-terminal'
import {
  emptyPendingLauncherOptions,
  hasPendingLauncherOptions,
  overlayPendingLauncherOptions,
  type PendingLauncherOptions
} from '@/components/agents/pending-launcher-options'
import { ConfigChip, ModeChip } from '@/components/chat/AgentHeader'
import { AttachFilesButton } from '@/components/chat/AttachFilesButton'
import { AttachmentPreviewGroup } from '@/components/chat/AttachmentPreviewGroup'
import { attachmentToBlock, dedupeAttachmentBlocks } from '@/components/chat/chat-attachments'
import {
  extractFastModeOption,
  filterDuplicateModeConfigOptions,
  partitionConfigOptions,
  resolveModelOption
} from '@/components/chat/chat-input-bar-config'
import { ChatComposerEditor } from '@/components/chat/composer/ChatComposerEditor'
import { FastModeToggle } from '@/components/chat/FastModeToggle'
import { FileMentionMenu } from '@/components/chat/FileMentionMenu'
import { McpBadge } from '@/components/chat/McpBadge'
import { SlashCommandMenu, type SlashMenuHandle } from '@/components/chat/SlashCommandMenu'
import { useChatComposer } from '@/components/chat/use-chat-composer'
import { useComposerAttachments } from '@/components/chat/use-composer-attachments'
import {
  useComposerCaretRestore,
  useComposerMentionSelect
} from '@/components/chat/use-composer-caret-restore'
import { useComposerMentions } from '@/components/chat/use-composer-mentions'
import { ArrowUp, Folder, FolderGit2, GitBranch, Paperclip, X } from '@/components/icons'
import { TermulMark } from '@/components/TermulMark'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useAcpRegistryCatalog } from '@/hooks/use-acp-registry-catalog'
import { useAgentSkills } from '@/hooks/use-agent-skills'
import { useAttachmentDropZone } from '@/hooks/use-attachment-drop-zone'
import { useMentionRecents } from '@/hooks/use-mention-recents'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useOskViewport } from '@/hooks/use-osk-viewport'
import { useResolvedSupportedAcpAgents } from '@/hooks/use-resolved-supported-acp-agents'
import {
  type AuthMethod,
  acpApi,
  type ContentBlock,
  type McpToolInfo,
  type ProbeStatus
} from '@/lib/acp-api'
import { normalizeCwdForScope } from '@/lib/acp-history-persistence'
import type { StoredMcpServer } from '@/lib/acp-mcp-persistence'
import { resolveAgentEnv } from '@/lib/agent-launch'
import { agentPolicy } from '@/lib/agents/acp-registry'
import { deriveAgentUpdates, deriveSpawnBasis } from '@/lib/agents/agent-update-utils'
import {
  installedBinaryConfig,
  manualBinaryConfig,
  pickDefaultSupportedAgent,
  type SupportedAcpAgentEntry,
  type SupportedAcpAgentManualInstall
} from '@/lib/agents/supported-acp-agents'
import { dialogApi, persistenceApi } from '@/lib/api'
import { registerSessionTempFiles } from '@/lib/attachment-temp-cleanup'
import { resolveEnvForSpawn } from '@/lib/env-parser'
import { logFrontendError } from '@/lib/log-api'
import { platform as osPlatform } from '@/lib/tauri-os'
import { getServerCapabilitySnapshot, subscribeServerCapability } from '@/lib/tauri-runtime'
import { terminalApi } from '@/lib/terminal-api'
import { cn } from '@/lib/utils'
import { randomUUID } from '@/lib/uuid'
import { type BaseBranchInfo, worktreeApi } from '@/lib/worktree-api'
import { getDefaultCwdForProject, getProjectRootPath } from '@/lib/worktree-context'
import {
  type AcpSession,
  agentReuseKey,
  hasModelRelevantOptionsCache,
  persistComposerOptions,
  prepareChatKey,
  useAcpSession,
  useAcpStore
} from '@/stores/acp-store'
import { useActiveProject, useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Worktree } from '@/types/project'

interface AgentLauncherProps {
  paneId: string
  className?: string
}

const EMPTY_COMMANDS: [] = []
const EMPTY_AUTH_METHODS: AuthMethod[] = []

const EMPTY_MCP_SERVERS: StoredMcpServer[] = []
const EMPTY_PROBE_STATUS: Record<string, ProbeStatus> = {}
const EMPTY_MCP_TOOLS: Record<string, McpToolInfo[]> = {}
const EMPTY_PROBE_ERROR: Record<string, string | undefined> = {}

/** Survives overlay unmount so the new-thread picker does not flash the default. */
let cachedConfigId: string | null = null

/** Test-only: clear the cross-unmount selection cache. */
export function __resetLauncherSelectionCache(): void {
  cachedConfigId = null
}

/** React hook over the server write-admission capability cache so the
 * launcher re-renders when the boot `/health` fetch resolves (the cache flips
 * `false`→`true`). Desktop short-circuits to `true` via `primeServerCapability`
 * (no fetch fires, cache seeded admitted). */
function useServerAdmitsRemoteWrites(): boolean {
  const { admitted } = useSyncExternalStore(
    subscribeServerCapability,
    getServerCapabilitySnapshot()
  )
  return admitted
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
  const editorRef = useRef<Editor | null>(null)
  const composerInputRef = useRef<HTMLElement | null>(null)
  const { scheduleRestoreCaret } = useComposerCaretRestore(editorRef)

  const acpConfigs = useAcpStore((s) => s.agentConfigs)
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const mcpServers = useAcpStore((s) => s.mcpServers) ?? EMPTY_MCP_SERVERS
  const mcpCount = mcpServers.length
  const setMcpServerEnabled = useAcpStore((s) => s.setMcpServerEnabled)
  const mcpProbeStatus = useAcpStore((s) => s.mcpProbeStatus) ?? EMPTY_PROBE_STATUS
  const mcpProbeError = useAcpStore((s) => s.mcpProbeError) ?? EMPTY_PROBE_ERROR
  const mcpTools = useAcpStore((s) => s.mcpTools) ?? EMPTY_MCP_TOOLS
  const loadMcpTools = useAcpStore((s) => s.loadMcpTools)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeProject = useActiveProject()
  const projectLabel = activeProject?.name ?? 'this folder'
  const projectRoot = activeProjectId ? getDefaultCwdForProject(activeProjectId) : undefined
  const projectIsGitRepo = Boolean(activeProject?.isGitRepo)
  const projectGitBranch = activeProject?.gitBranch ?? null
  // CAP-2: isolation mode + base-branch picker. Worktree mode requires a git
  // repo; the selector is hidden on non-repo projects. CAP — Web worktree
  // parity: the worktree mutation routes ship over HTTP (`web/worktree_api.rs`)
  // so the launcher's worktree mode picker is no longer gated on `isTauriContext()`
  // alone. The write routes (`/worktree/create` etc.) are loopback-guarded
  // (`check_local_only`), so the picker is gated on the server's advertised
  // write-admission (`useServerAdmitsRemoteWrites`, primed from `GET /health`)
  // — the desktop (always local) and a web client whose server admits its
  // writes (e.g. standalone `termul-server --allow-remote-writes` behind a
  // Cloudflare tunnel, or a loopback browser) see it; a web client whose
  // server denies writes (desktop shared-live, or a non-loopback peer without
  // the opt-in) does not, avoiding a picker that would fail `FORBIDDEN` at
  // launch. The hook subscribes to the cache so the picker re-renders when the
  // boot fetch resolves.
  const serverAdmitsWrites = useServerAdmitsRemoteWrites()
  const canUseWorktree = projectIsGitRepo && serverAdmitsWrites
  const [isolationMode, setIsolationMode] = useState<'current' | 'worktree'>('current')
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [baseBranchInfo, setBaseBranchInfo] = useState<BaseBranchInfo | null>(null)
  // Local branch names for the base-branch picker (CAP-2). Sourced from
  // `worktreeApi.branches` so detached-HEAD users can pick any valid branch,
  // not just the resolved default.
  const [branches, setBranches] = useState<string[]>([])
  const [worktreeCreating, setWorktreeCreating] = useState(false)
  // Skills live at {project.path}/.agents/skills/ which is gitignored and
  // excluded from worktree symlinks, so resolve against the main project root
  // — not the worktree CWD which has no .agents/skills/.
  const skillsRoot = activeProjectId ? getProjectRootPath(activeProjectId) : undefined
  const { skills } = useAgentSkills(skillsRoot)
  const supportedAgents = useResolvedSupportedAcpAgents(acpConfigs)
  const { usingRemoteRegistry, activeRegistry, remoteRegistry, applyRemoteRegistry } =
    useAcpRegistryCatalog()
  const applyAgentUpdate = useAcpStore((s) => s.applyAgentUpdate)

  // Per-agent Update Check (see CONTEXT.md): drift between each agent's spawn
  // version and the target registry — the applied registry when opted in,
  // otherwise the advisory Remote Snapshot. Badge count = version bumps only.
  const agentUpdates = useMemo(() => {
    const target = usingRemoteRegistry ? activeRegistry : remoteRegistry
    if (target.length === 0) return []
    return deriveAgentUpdates({
      registry: target,
      spawnBasis: deriveSpawnBasis(supportedAgents)
    })
  }, [usingRemoteRegistry, activeRegistry, remoteRegistry, supportedAgents])

  // Agent ids with drift, for the entrance picker's per-row marker.
  const updateAgentIds = useMemo(
    () => new Set(agentUpdates.map((update) => update.agentId)),
    [agentUpdates]
  )

  // Single-update CTA for the CURRENTLY SELECTED agent (no batch): the
  // registry agent behind the selected entry's drift, when one exists.
  const targetRegistry = usingRemoteRegistry ? activeRegistry : remoteRegistry
  const selectedEntry = useMemo(
    () =>
      supportedAgents.find((entry) => entry.configId === selectedConfigId) ??
      pickDefaultSupportedAgent(supportedAgents) ??
      supportedAgents[0] ??
      null,
    [supportedAgents, selectedConfigId]
  )
  const {
    selectedUpdateAgent,
    updating: updatingSelected,
    handleUpdate: handleSelectedAgentUpdate
  } = useSelectedAgentUpdate(selectedEntry, agentUpdates, {
    usingRemoteRegistry,
    targetRegistry,
    applyRemoteRegistry,
    applyAgentUpdate
  })
  const pendingRestartVersion = useAcpStore((s) =>
    selectedEntry ? (s.pendingRestartVersions[selectedEntry.configId] ?? null) : null
  )
  const [restartingUpdatedAgent, setRestartingUpdatedAgent] = useState(false)
  const handleRestartUpdatedAgent = useCallback(() => {
    if (
      !selectedEntry ||
      !pendingRestartVersion ||
      !projectRoot ||
      !activeProjectId ||
      restartingUpdatedAgent
    ) {
      return
    }
    const configId = selectedEntry.configId
    const agentName = selectedEntry.config?.name ?? selectedEntry.agent.name
    const version = pendingRestartVersion
    setRestartingUpdatedAgent(true)
    void (async () => {
      try {
        // Start a fresh session against the updated config. Update Application
        // detaches any process with live chats, so those chats keep running
        // the old version while this new chat uses the applied version.
        const sessionId = await useAcpStore
          .getState()
          .startChat(configId, projectRoot, undefined, activeProjectId)
        useWorkspaceStore.getState().addAgentChatTab(sessionId, paneId)
        useWorkspaceStore.getState().hideAgentLauncher()
        void logFrontendError({
          level: 'info',
          source: 'agentLauncher.restartUpdatedAgent',
          message: `Started a new ${agentName} chat on version ${version}`
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(`Could not restart ${agentName}: ${message}`)
        void logFrontendError({
          level: 'error',
          source: 'agentLauncher.restartUpdatedAgent',
          message: `Could not start a new ${agentName} chat on version ${version}: ${message}`
        })
      } finally {
        setRestartingUpdatedAgent(false)
      }
    })()
  }, [
    selectedEntry,
    pendingRestartVersion,
    projectRoot,
    activeProjectId,
    paneId,
    restartingUpdatedAgent
  ])

  const manualInstallContext =
    selectedEntry?.manualInstall ??
    (selectedEntry?.status === 'install-required' ? manualInstallOverride : null)
  const selectedConfig = selectedEntry?.config ?? null
  const selectedInstall = selectedEntry?.install ?? null
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
  // Headless ACP auth (spec-acp-terminal-auth): the URL the live agent tried
  // to open via the host's browser-open shim is surfaced globally by
  // BrowserAuthDialogHost (mounted in both app roots) — the launcher no
  // longer owns the dialog.
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
    handlePaste,
    removeAttachment,
    clearAttachments,
    appOwnedTempPaths,
    canPick,
    canDropPaste
  } = useComposerAttachments({ imageCapable, embedCapable, disabled: composerDisabled })
  // Drag feedback for the attachment drop zone (shared with ChatInputBar):
  // depth-counted dragenter/dragleave pairs; the overlay render stays local.
  const { dragActive, dropProps } = useAttachmentDropZone({ canDropPaste, addFiles })
  const { recents: mentionRecents, pushRecent: pushMentionRecent } = useMentionRecents(
    activeProjectId,
    projectRoot
  )
  const mentions = useComposerMentions({
    rootPath: projectRoot,
    disabled: composerDisabled,
    recents: mentionRecents,
    onStageFileRef: (m) => {
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
  // `persistSelection` is declared before the ACP setters below so the setters
  // ACP setters below so the setters can close over them without a temporal-dead-zone
  // reference (the setters are also passed into `useChatComposer` before its line).
  const persistSelection = useCallback((configId: string) => {
    cachedConfigId = configId
    void persistenceApi.write<LastSelectedAgent>(PersistenceKeys.lastSelectedAgent, {
      agentId: configId,
      mode: 'acp'
    })
  }, [])

  // Composer-selection persistence is delegated to the store's
  // `persistComposerOptions` helper, which serializes per-key mutations so
  // concurrent calls (e.g. model + mode in the same tick) can't overwrite
  // each other. The launcher persists explicit choices even when they are
  // applied to a prepared warm session; store setters skip persistence for
  // implicit warm-session defaults.
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
        if (activeConfigId) {
          persistComposerOptions(activeConfigId, {
            configValues: { [configId]: valueId }
          })
        }
        return
      }
      try {
        await useAcpStore.getState().setConfigOption(preparedSessionId, configId, valueId)
      } catch (err) {
        toast.error(`Failed to set option: ${String(err)}`)
        throw err
      }
    },
    [preparedSessionId, activeConfigId]
  )

  const handleSetModel = useCallback(
    async (valueId: string) => {
      if (!preparedSessionId) {
        if (modelSource === 'models') {
          setPendingOptions((prev) => ({ ...prev, modelId: valueId }))
          if (activeConfigId) {
            persistComposerOptions(activeConfigId, { modelId: valueId })
          }
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
        if (activeConfigId) {
          persistComposerOptions(activeConfigId, {
            modelId: valueId,
            configValues: { [modelOption.id]: valueId }
          })
        }
        return
      }
      if (modelSource === 'models') {
        try {
          await useAcpStore.getState().setModel(preparedSessionId, valueId)
          if (activeConfigId) {
            persistComposerOptions(activeConfigId, { modelId: valueId })
          }
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
      if (activeConfigId) {
        persistComposerOptions(activeConfigId, {
          modelId: valueId,
          configValues: { [modelOption.id]: valueId }
        })
      }
    },
    [handleSetConfig, modelOption, modelSource, preparedSessionId, activeConfigId]
  )

  const handleSetMode = useCallback(
    async (modeId: string) => {
      if (!preparedSessionId) {
        setPendingOptions((prev) => ({ ...prev, modeId }))
        if (activeConfigId) {
          persistComposerOptions(activeConfigId, { modeId })
        }
        return
      }
      try {
        await useAcpStore.getState().setMode(preparedSessionId, modeId)
      } catch (err) {
        toast.error(`Failed to set agent: ${String(err)}`)
        throw err
      }
    },
    [preparedSessionId, activeConfigId]
  )

  // Mention-menu wiring (was in `useComposerTextarea`, now inlined — the
  // textarea is gone; the editor's `onCaretChange` feeds `mentions.update` on
  // natural typing, and `handleSelect`/`onMentionSelect` feed it on
  // programmatic splices).
  const mentionSections = mentions.sections
  const mentionMenuRef = mentions.menuRef
  const emptyLabel = mentions.loading ? 'Searching files…' : 'No files match. Try another name.'
  const resetMentions = mentions.reset
  const onMentionSelect = useComposerMentionSelect({
    value: prompt,
    setValue: setPrompt,
    editorRef,
    mentions,
    scheduleRestoreCaret
  })

  const {
    slashOpen,
    slashSections,
    skillPathsRef,
    hasCommandToken,
    handleSelect,
    onSlashOrMentionKeyDown,
    buildPromptParts
  } = useChatComposer({
    value: prompt,
    setValue: setPrompt,
    editorRef,
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
    mentions,
    scheduleRestoreCaret
  })
  const mentionMenuOpen = mentions.menuOpen && !composerDisabled && !slashOpen

  // Restore persisted composer selections for the current agent on mount and
  // on agent change. Seeds `pendingOptions` (model/mode/config) +
  // `isolationMode`/`baseBranch` (worktree) so the next chat starts with the
  // user's last pick. Fallbacks: drop selections no longer advertised by the
  // agent; fall back to 'current' when worktree is no longer available; fall
  // back to defaultBase when baseBranch is no longer in the branch list.
  // Runs on agent change; options may not be loaded yet on first run (cache
  // miss + prepareChat in flight), so validation is best-effort — invalid
  // selections are dropped silently if options are available, otherwise
  // accepted as-is (the agent will ignore unknown values at launch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on agent change only; options/branches are read at run time, re-running on every options change would re-seed and fight user edits.
  useEffect(() => {
    if (!activeConfigId) return
    let cancelled = false
    void (async () => {
      try {
        const result = await persistenceApi.read<PersistedComposerOptions>(
          PersistenceKeys.lastComposerOptions(activeConfigId)
        )
        if (cancelled) return
        if (!result.success || !result.data) return
        const saved = result.data
        const configValues: Record<string, string> = {}
        if (saved.configValues) {
          for (const [cid, vid] of Object.entries(saved.configValues)) {
            const opt = effectiveConfigOptions.find((o) => o.id === cid)
            // Drop the value when the option is missing OR the value is no
            // longer in the option's advertised values.
            if (opt?.options.some((o) => o.value === vid)) {
              configValues[cid] = vid
            } else {
              void logFrontendError({
                level: 'warn',
                source: 'agentLauncher.restoreComposerOptions',
                message: `dropping persisted config — option ${cid} no longer advertised`
              })
            }
          }
        }
        let modelId = saved.modelId
        if (modelId) {
          const modelOpt = resolveModelOption(
            partitionConfigOptions(effectiveConfigOptions).model,
            effectiveModels
          ).option
          if (modelOpt && !modelOpt.options.some((o) => o.value === modelId)) {
            void logFrontendError({
              level: 'warn',
              source: 'agentLauncher.restoreComposerOptions',
              message: 'dropping persisted model — no longer advertised'
            })
            modelId = undefined
          }
        }
        let modeId = saved.modeId
        if (modeId && effectiveModes) {
          if (!effectiveModes.availableModes.some((m) => m.id === modeId)) {
            void logFrontendError({
              level: 'warn',
              source: 'agentLauncher.restoreComposerOptions',
              message: 'dropping persisted mode — no longer advertised'
            })
            modeId = undefined
          }
        }
        if (modelId || modeId || Object.keys(configValues).length > 0) {
          setPendingOptions({ modelId, modeId, configValues })
        }
        if (saved.isolationMode === 'worktree' && canUseWorktree && saved.baseBranch) {
          setIsolationMode('worktree')
          if (
            branches.length > 0 &&
            !branches.includes(saved.baseBranch) &&
            baseBranchInfo?.defaultBase
          ) {
            setBaseBranch(baseBranchInfo.defaultBase)
          } else {
            setBaseBranch(saved.baseBranch)
          }
        }
      } catch {
        // Best-effort — silent failure, launcher shows agent defaults.
      }
    })()
    return () => {
      cancelled = true
    }
    // Re-run on agent change only. Options/branches are read at run time;
    // re-running on every options change would re-seed and fight user edits.
  }, [activeConfigId])

  // Restore the last-selected agent on mount if no agent is selected yet.
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

  // CAP-2: resolve the origin-aware default base branch and local branch list
  // once per desktop git project so the context-strip picker is ready when the
  // user switches to worktree mode.
  useEffect(() => {
    if (!canUseWorktree || !projectRoot) return
    let cancelled = false
    void (async () => {
      try {
        const result = await worktreeApi.resolveBaseBranch(projectRoot)
        if (cancelled) return
        if (result.success && result.data) {
          setBaseBranchInfo(result.data)
          // Fetch local branches so the picker lists every valid option
          // (detached-HEAD users can pick any branch).
          const branchResult = await worktreeApi.branches(projectRoot)
          if (cancelled) return
          if (branchResult.success && branchResult.data) {
            const local = branchResult.data.filter((b) => !b.isRemote).map((b) => b.name)
            setBranches(local)
          }
        } else {
          void logFrontendError({
            level: 'warn',
            source: 'agentLauncher.resolveBaseBranch',
            message: `resolveBaseBranch failed: ${result.success ? '' : result.error}`
          })
        }
      } catch (err) {
        if (!cancelled) {
          void logFrontendError({
            level: 'warn',
            source: 'agentLauncher.resolveBaseBranch',
            message: `resolveBaseBranch threw: ${String(err)}`
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [canUseWorktree, projectRoot])

  // CAP-2: entering worktree mode defaults the picker to the resolved base
  // branch. Detached HEAD skips the auto-fill so the user must pick.
  useEffect(() => {
    if (isolationMode !== 'worktree' || baseBranch || !baseBranchInfo || baseBranchInfo.isDetached)
      return
    setBaseBranch(baseBranchInfo.defaultBase)
  }, [isolationMode, baseBranch, baseBranchInfo])

  // Persist worktree isolation mode + base branch changes for the current
  // agent so the next chat starts with the same worktree preference. Only
  // persists when worktree mode is available (`canUseWorktree`) — a non-git
  // project falls back to 'current' and does not overwrite the persisted pick.
  useEffect(() => {
    if (!activeConfigId) return
    if (!canUseWorktree) return
    persistComposerOptions(activeConfigId, {
      isolationMode,
      baseBranch: isolationMode === 'worktree' ? baseBranch : null
    })
  }, [activeConfigId, isolationMode, baseBranch, canUseWorktree])

  // Validate the restored `baseBranch` once the branch list loads. The restore
  // effect (on `[activeConfigId]`) may set a persisted branch before
  // `worktreeApi.branches` resolves. If the branch was deleted, fall back to
  // the resolved default.
  useEffect(() => {
    if (isolationMode !== 'worktree' || !baseBranch || branches.length === 0) return
    if (branches.includes(baseBranch)) return
    if (baseBranchInfo?.defaultBase) {
      setBaseBranch(baseBranchInfo.defaultBase)
    }
  }, [isolationMode, baseBranch, branches, baseBranchInfo])

  useEffect(() => {
    if (!activeConfigId || !projectRoot || selectedEntry?.status !== 'ready' || !selectedConfig)
      return
    let cancelled = false
    void (async () => {
      try {
        // Persist a registry-derived config only when no persisted config
        // exists yet. `supportedAgents` refreshes asynchronously after an
        // Update Application, so the selected entry can briefly still carry
        // the old launch args while the store already has the new pin. Never
        // let that stale snapshot overwrite the user's persisted config.
        const hasPersistedConfig = acpConfigs.some((config) => config.id === selectedConfig.id)
        if (!hasPersistedConfig) {
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

  const handleInstallAgent = useCallback(
    async (entry: SupportedAcpAgentEntry) => {
      if (!entry.install || installingConfigId) return
      setSelectedConfigId(entry.configId)
      persistSelection(entry.configId)
      setInstallingConfigId(entry.configId)
      try {
        // CAP-6 / Story 9: host-owned verified-atomic install. The request is
        // `{ agentId }` only; the host resolves everything (archive URL, cmd,
        // args, sha256) from the trusted catalog. The outcome's
        // `{ command, args }` flows through `installedBinaryConfig` →
        // `saveAgentConfig` unchanged.
        const installed = await acpApi.installAcpAgent(entry.agent.id)
        const config = installedBinaryConfig(
          entry.agent,
          installed,
          entry.install.kind === 'archive' ? { env: entry.install.env } : {}
        )
        await saveAgentConfig(config)
        setSelectedConfigId(config.id)
        persistSelection(config.id)
        toast.success(`${entry.agent.name} installed`)
      } catch (err) {
        toast.error(`Failed to install ${entry.agent.name}: ${String(err)}`)
        if (entry.install.kind === 'archive') {
          setManualInstallOverride({
            cmd: entry.install.cmd,
            args: entry.install.args,
            env: entry.install.env
          })
        }
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

  // Factory inline-key auth (AgentAuthPolicy.inlineKeyFormMethodId): the key
  // is stored on the host and the chat re-prepares on save. The special case
  // inside `handleAuthMethod` collapses to this hook's exposed callback.
  const factoryKeyAuth = useFactoryKeyAuth(selectedConfig, projectRoot, handleRetryPrepare)

  const handleSelectAgent = useCallback(
    (entry: SupportedAcpAgentEntry) => {
      // No-op when re-selecting the same agent — avoids resetting
      // worktree/pending state and overwriting the persisted record.
      if (entry.configId === selectedConfigId) {
        editorRef.current?.commands.focus(undefined, { scrollIntoView: false })
        return
      }
      setManualPath('')
      setManualInstallOverride(null)
      factoryKeyAuth.cancel()
      setPendingOptions(emptyPendingLauncherOptions())
      // Reset worktree isolation + base branch; the restore effect on
      // `[activeConfigId]` will re-seed them from the persisted record for
      // the new agent (or leave them at 'current'/null if no record exists).
      setIsolationMode('current')
      setBaseBranch(null)
      setSelectedConfigId(entry.configId)
      persistSelection(entry.configId)
      editorRef.current?.commands.focus(undefined, { scrollIntoView: false })
    },
    [persistSelection, selectedConfigId, factoryKeyAuth]
  )

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

  // Terminal auth methods (spec-acp-terminal-auth): spawn the agent binary
  // with the method's args/env in a real terminal tab so its login TUI runs
  // interactively. Exit code 0 → run the ACP `authenticate` + re-prepare;
  // non-zero → toast and the banner stays (the user can retry). The login
  // terminal is an ordinary extra tab — never killed or recreated.
  const loginAuthInFlightRef = useRef(false)
  const loginExitUnlistenRef = useRef<(() => void) | null>(null)
  // Detach a pending login-exit listener on unmount — the terminal outlives
  // the launcher, but the callback must not fire into a dead component.
  useEffect(
    () => () => {
      loginExitUnlistenRef.current?.()
      loginExitUnlistenRef.current = null
    },
    []
  )
  const runTerminalAuth = useCallback(
    async (method: AuthMethod) => {
      if (!liveAgentId || !selectedConfig || !projectRoot || !activeProjectId) {
        toast.error('Agent is not connected. Use Retry to reconnect, then sign in again.')
        return
      }
      // Ref guard: `signingInMethodId` state races a fast double-click and
      // would spawn duplicate login terminals.
      if (loginAuthInFlightRef.current) return
      loginAuthInFlightRef.current = true
      const agentId = liveAgentId
      const agentName = selectedConfig.name
      setSigningInMethodId(method.id)
      let ptyId: string | null = null
      // The listener and the post-spawn getExitCode poll can both observe the
      // same exit — handle it once.
      let exitHandled = false
      const handleExit = (exitCode: number): void => {
        if (exitHandled) return
        exitHandled = true
        loginExitUnlistenRef.current?.()
        loginExitUnlistenRef.current = null
        loginAuthInFlightRef.current = false
        setSigningInMethodId(null)
        if (exitCode === 0) {
          // The login TUI writes credentials itself, so `authenticate`
          // typically returns immediately — it also covers agents that gate
          // on the explicit call. `authenticateAgent` shares the in-flight
          // dedup + marks the agent authenticated so `createSession` skips
          // its own authenticate. Re-prepare regardless of the authenticate
          // outcome: the TUI already wrote credentials, so the session can
          // proceed even when the explicit call fails.
          void useAcpStore
            .getState()
            .authenticateAgent(agentId, method.id)
            .catch((err) => {
              toast.error(err instanceof Error ? err.message : 'Sign-in failed')
            })
            .finally(() => handleRetryPrepare())
        } else {
          toast.error(`${agentName} sign-in exited with code ${exitCode}.`)
        }
      }
      // Register the exit listener BEFORE spawn so an exit that lands while
      // the spawn is in flight is still observed; the getExitCode poll below
      // covers the remaining gap (exit before the listener attached).
      const unlisten = terminalApi.onExit((id, exitCode) => {
        if (ptyId === null || id !== ptyId) return
        handleExit(exitCode)
      })
      loginExitUnlistenRef.current = unlisten
      try {
        // Merge project env → agent-config env → method env (same layering
        // as launchAgentInPane; method env wins — it is the auth flow's own
        // contract).
        const { env: projectEnv } = resolveEnvForSpawn(activeProject?.envVars, {})
        const mergedEnv = {
          ...projectEnv,
          ...resolveAgentEnv(selectedConfig.env, projectEnv),
          ...(method.env ?? {})
        }
        const spawnResult = await spawnAcpLoginTerminal({
          paneId,
          projectId: activeProjectId,
          cwd: projectRoot,
          program: selectedConfig.command,
          // `AuthMethodTerminal.args` are ADDITIONAL args appended to the
          // agent's configured argv (devin advertises `["--login"]` →
          // `devin acp --login`). Dropping config.args would yield
          // `devin --login` — works for devin's hidden top-level flag but
          // breaks agents whose login lives under the configured subcommand.
          args: [...(selectedConfig.args ?? []), ...(method.args ?? [])],
          ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
          tabName: `Sign in — ${agentName}`
        })
        if (!spawnResult.success || !spawnResult.ptyId) {
          unlisten()
          loginExitUnlistenRef.current = null
          loginAuthInFlightRef.current = false
          setSigningInMethodId(null)
          toast.error(spawnResult.error ?? 'Could not open the sign-in terminal.')
          return
        }
        ptyId = spawnResult.ptyId
        // Fallback: the login process may have exited between spawn and the
        // listener observing it — poll the recorded exit code once.
        const exitResult = await terminalApi.getExitCode(ptyId)
        if (exitResult.success && exitResult.data !== null) {
          handleExit(exitResult.data)
        }
      } catch (err) {
        unlisten()
        loginExitUnlistenRef.current = null
        loginAuthInFlightRef.current = false
        setSigningInMethodId(null)
        toast.error(err instanceof Error ? err.message : 'Could not open the sign-in terminal.')
      }
    },
    [
      liveAgentId,
      selectedConfig,
      projectRoot,
      activeProjectId,
      activeProject,
      paneId,
      handleRetryPrepare
    ]
  )

  // The inline-key method from the selected agent's auth policy (replaces the
  // former `'factory-droid'` / `'factory-api-key'` magic-string comparisons):
  // when the chosen method matches, the launcher shows its inline key form.
  const selectedAuthPolicy = selectedEntry ? agentPolicy(selectedEntry.id).auth : null
  const inlineKeyMethodId =
    selectedAuthPolicy?.mode === 'acp' ? selectedAuthPolicy.inlineKeyFormMethodId : undefined

  // Dispatch an auth method by type: 'agent' (or a missing type — the
  // pre-extension wire only carried agent methods) → provider-owned
  // authenticate; 'terminal' → login terminal tab; anything else ('env_var',
  // 'unknown', future variants) → unsupported. Unknown types are NEVER sent
  // to `authenticate` — the host would reject an id it cannot drive. The
  // inline-key form method (AgentAuthPolicy.inlineKeyFormMethodId) routes to
  // the Factory key form instead of an ACP authenticate round-trip.
  const handleAuthMethod = useCallback(
    (method: AuthMethod) => {
      if (inlineKeyMethodId != null && method.id === inlineKeyMethodId) {
        factoryKeyAuth.requestKeyInput()
      } else if (method.type === 'terminal') {
        void runTerminalAuth(method)
      } else if (method.type === 'agent' || method.type == null) {
        void runAuthenticate(method.id)
      } else {
        toast.error('This sign-in method is not supported yet.')
      }
    },
    [runTerminalAuth, runAuthenticate, inlineKeyMethodId, factoryKeyAuth]
  )

  const handleSignIn = useCallback(() => {
    if (!signInMethod) {
      toast.error('No sign-in method is available for this agent yet.')
      return
    }
    handleAuthMethod(signInMethod)
  }, [signInMethod, handleAuthMethod])

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
    const { wireWithCommand, displayWithCommand, fileBlocks } = parts

    // CAP-3: when worktree mode is selected, create the isolated worktree
    // BEFORE opening the chat placeholder so the agent's cwd is the worktree
    // path from the first turn. Branch is `chat/{id}` (deterministic, id-scoped
    // — collision-retry-friendly). Collision-retry appends `-2` once.
    let worktreePath: string | undefined
    let worktreeBranch: string | undefined
    let launchCwd = projectRootSnapshot
    if (isolationMode === 'worktree' && canUseWorktree) {
      if (!baseBranch) {
        toast.error('Pick a base branch for the worktree')
        launchInFlightRef.current = false
        return
      }
      setWorktreeCreating(true)
      try {
        const chatId = randomUUID().slice(0, 8)
        const branchName = `chat/${chatId}`
        const createResult = await worktreeApi.create({
          projectPath: projectRootSnapshot,
          name: chatId,
          branch: branchName,
          isNewBranch: true,
          startRef: baseBranch
        })
        let worktreePathResult: string | null =
          createResult.success && createResult.data ? createResult.data.path : null
        let worktreeBranchResult: string = branchName
        // Track the worktree NAME actually used (the retry branch appends `-2`),
        // so the project-store entry's `name` matches the git worktree on disk.
        let worktreeNameResult: string = chatId
        if (!worktreePathResult) {
          const failCode = createResult.success ? 'UNKNOWN' : createResult.code
          if (failCode === 'WORKTREE_EXISTS' || failCode === 'BRANCH_ALREADY_HAS_WORKTREE') {
            // Collision-retry: append `-2` suffix once (stale state from a
            // prior crashed run). Never deadlock — a second collision surfaces
            // an error.
            const retryId = `${chatId}-2`
            const retryBranch = `${branchName}-2`
            void logFrontendError({
              level: 'warn',
              source: 'agentLauncher.worktreeCreate',
              message: `collision on ${branchName}, retrying as ${retryBranch}`
            })
            const retryResult = await worktreeApi.create({
              projectPath: projectRootSnapshot,
              name: retryId,
              branch: retryBranch,
              isNewBranch: true,
              startRef: baseBranch
            })
            if (retryResult.success && retryResult.data) {
              worktreePathResult = retryResult.data.path
              worktreeBranchResult = retryBranch
              worktreeNameResult = retryId
            } else {
              const retryErr = retryResult.success ? 'unknown' : retryResult.error
              throw new Error(`Worktree creation failed: ${retryErr}`)
            }
          } else {
            const createErr = createResult.success ? 'unknown' : createResult.error
            throw new Error(`Worktree creation failed: ${createErr}`)
          }
        }
        if (worktreePathResult) {
          worktreePath = worktreePathResult
          worktreeBranch = worktreeBranchResult
          launchCwd = worktreePathResult
          // CAP-5: carry over untracked files listed in `.worktree-include`.
          // Symlink/path-escape/already-present defenses run on the host.
          // Best-effort: a copy failure must not orphan the freshly created
          // worktree + branch — log and continue launching into it.
          try {
            const includeResult = await worktreeApi.copyIncludeFiles(
              projectRootSnapshot,
              worktreePathResult
            )
            if (!includeResult.success) {
              void logFrontendError({
                level: 'warn',
                source: 'agentLauncher.worktreeInclude',
                message: `copyIncludeFiles failed: ${includeResult.success ? '' : includeResult.error}`
              })
            } else if (includeResult.data) {
              // Boundary log (info-level): not an error, so console.info is
              // appropriate (logFrontendError is error/warn only).
              console.info(
                `[agentLauncher.worktreeInclude] carry-over ran=${includeResult.data.ran} copied=${includeResult.data.copied} skipped=${includeResult.data.skipped.length}`
              )
            }
          } catch (includeErr) {
            void logFrontendError({
              level: 'warn',
              source: 'agentLauncher.worktreeInclude',
              message: `copyIncludeFiles threw: ${includeErr instanceof Error ? includeErr.message : String(includeErr)}`
            })
          }

          // Register the just-created worktree in the project store and
          // activate it so the Chats sidebar scopes to it immediately (no
          // 60s reconciler wait) and the worktree survives across restarts.
          // Dedupe by path against already-stored worktrees so the reconciler
          // cannot add a second entry for the same path later. Best-effort:
          // a failure logs a warn and the chat still opens below.
          try {
            const projectStore = useProjectStore.getState()
            const stored = projectStore.projects.find((p) => p.id === projectIdSnapshot)
            // Dedupe by normalized path: worktreeApi.create and an already-stored
            // entry (from a prior launch or the reconciler's worktreeApi.list)
            // can differ by trailing slash / verbatim prefix. Without
            // normalization the dedup misses and addWorktree creates a duplicate
            // the comment below claims to prevent.
            const alreadyStored = stored?.worktrees?.find(
              (w) => normalizeCwdForScope(w.path) === normalizeCwdForScope(worktreePathResult)
            )
            if (alreadyStored) {
              projectStore.setActiveWorktree(projectIdSnapshot, alreadyStored.id)
            } else {
              const newWorktree: Worktree = {
                id: randomUUID(),
                name: worktreeNameResult,
                branch: worktreeBranchResult,
                path: worktreePathResult,
                createdAt: new Date().toISOString()
              }
              projectStore.addWorktree(projectIdSnapshot, newWorktree)
              projectStore.setActiveWorktree(projectIdSnapshot, newWorktree.id)
            }
            // Boundary log (info-level): not an error, so console.info is
            // appropriate (logFrontendError is error/warn only).
            console.info(
              `[agentLauncher.worktreeRegister] activated branch=${worktreeBranchResult} path=${worktreePathResult}`
            )
          } catch (registerErr) {
            void logFrontendError({
              level: 'warn',
              source: 'agentLauncher.worktreeRegister',
              message: `register/activate failed: ${registerErr instanceof Error ? registerErr.message : String(registerErr)}`
            })
          }
        }
      } catch (err) {
        setWorktreeCreating(false)
        toast.error(err instanceof Error ? err.message : 'Failed to create worktree')
        launchInFlightRef.current = false
        return
      }
      setWorktreeCreating(false)
    }

    // Open the chat immediately; ACP spawn/session/send continue in the chat view.
    const store = useAcpStore.getState()
    let sessionId =
      preparedKeySnapshot != null && isolationMode !== 'worktree'
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
        cwd: launchCwd,
        projectId: projectIdSnapshot,
        models: modelsSnapshot,
        modes: modesSnapshot,
        configOptions: configOptionsSnapshot,
        initialUserBlocks: syncBlocks.length > 0 ? syncBlocks : undefined,
        worktreePath,
        worktreeBranch
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
    clearAttachments()
    resetMentions()
    setPrompt('')

    void (async () => {
      try {
        if (needsSave) {
          await saveAgentConfig(configSnapshot)
        }
        persistSelection(configSnapshot.id)
        // Persist the final composer selections snapshot (model/mode/config
        // + worktree isolation + base branch) so the next chat starts with
        // the user's last pick. The store setters already persisted
        // running-chatbox changes; this catches the pre-launch pending
        // options that never went through a store setter (no prepared session).
        persistComposerOptions(configSnapshot.id, {
          modelId: pendingSnapshot.modelId,
          modeId: pendingSnapshot.modeId,
          configValues:
            Object.keys(pendingSnapshot.configValues).length > 0
              ? pendingSnapshot.configValues
              : undefined,
          isolationMode,
          baseBranch: isolationMode === 'worktree' ? baseBranch : null
        })

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
        // File-mention `resource_link` blocks append to the wire only — the
        // display keeps the raw token text so the timeline renders inline
        // file pills. Dedupe by path (matching `dedupeAttachmentBlocks`).
        blocks.push(...fileBlocks)
        const wireBlocks = dedupeAttachmentBlocks(blocks)

        const liveStore = useAcpStore.getState()
        let realId = sessionId
        if (usedPlaceholder) {
          realId = await liveStore.finalizeChatLaunch({
            placeholderId: sessionId,
            configId: configSnapshot.id,
            cwd: launchCwd,
            projectId: projectIdSnapshot,
            mcpServers: undefined,
            pending: hasPendingLauncherOptions(pendingSnapshot) ? pendingSnapshot : null,
            initialText: null,
            initialBlocks: wireBlocks.length > 0 ? wireBlocks : null,
            adoptSession: (from, to) => {
              useWorkspaceStore.getState().remapAgentChatSession(from, to, paneSnapshot)
            },
            worktreePath,
            worktreeBranch
          })
        } else {
          await liveStore.applyPendingLauncherOptions(
            realId,
            hasPendingLauncherOptions(pendingSnapshot) ? pendingSnapshot : null
          )
          if (wireBlocks.length > 0) {
            await liveStore.sendPromptBlocks(realId, wireBlocks, {
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
    pendingOptions,
    preparedKey,
    effectiveModels,
    effectiveModes,
    effectiveConfigOptions,
    buildPromptParts,
    skillPathsRef,
    isolationMode,
    canUseWorktree,
    baseBranch
  ])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean | undefined => {
      // Editor-first keymap: the slash/mention menu keys + Enter→launch /
      // Escape→hide run BEFORE the editor's own keymap (Backspace-pill removal
      // is editor-owned). `onSlashOrMentionKeyDown` consumes the slash/mention
      // menu arrows/Tab/Enter/Escape when their menus are open; Enter→launch
      // and Escape→hide are surface-specific (the launcher dispatches a chat
      // launch, not a running-turn send).
      if (onSlashOrMentionKeyDown(event) === true) return true
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.isComposing
      ) {
        event.preventDefault()
        void launch()
        return true
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void launch()
        return true
      }
      if (event.key === 'Escape') {
        useWorkspaceStore.getState().hideAgentLauncher()
        return true
      }
      return undefined
    },
    [onSlashOrMentionKeyDown, launch]
  )

  const canLaunch =
    Boolean(selectedConfig) &&
    selectedEntry?.status === 'ready' &&
    (prompt.trim().length > 0 || attachments.length > 0) &&
    // CAP-2: worktree mode requires an explicit base branch before launch —
    // covers detached HEAD (no current) and any case where the picker has
    // not settled on a value.
    !(isolationMode === 'worktree' && !baseBranch) &&
    !worktreeCreating
  // Deduplicated base-branch options for the picker (CAP-2): current branch
  // first (marked), then the resolved default, the project's reactive branch,
  // then every local branch from `worktreeApi.branches` so detached-HEAD
  // users can pick any valid branch. Exact-equality dedup prevents repeated
  // SelectItem values (projectGitBranch clashing with currentBranch, etc.).
  const baseOptions: { value: string; label: string }[] = (() => {
    const seen = new Set<string>()
    const out: { value: string; label: string }[] = []
    const add = (value: string | undefined | null, isCurrent = false) => {
      if (!value) return
      if (seen.has(value)) return
      seen.add(value)
      out.push({ value, label: isCurrent ? `${value} (current)` : value })
    }
    add(baseBranchInfo?.currentBranch, true)
    add(baseBranchInfo?.defaultBase)
    add(projectGitBranch, true)
    for (const b of branches) add(b)
    return out
  })()

  // Story 11 (QA F9): on the mobile web shell the centered launcher floats
  // mid-screen with dead space below — the composer is unreachable without a
  // stretch. Bottom-anchor the whole column (justify-end) so the composer box
  // sits in the thumb zone; the hero shrinks (smaller mark + tighter margins)
  // so the column still fits above the fold. Desktop keeps the centered
  // layout byte-identical.
  const isMobileShell = useMobileWebShell()
  // Keyboard-aware bottom anchor: when the OSK opens, the visual viewport
  // shrinks but (iOS) the layout viewport does not — inset the bottom by the
  // live keyboard height so the composer stays visible above the keys. The
  // same --termul-keyboard-height CSS var mirrors this value document-wide.
  const osk = useOskViewport()
  // Story 11 (QA F5, mobile): the pane-level overlay chrome's close X is a
  // 32px desktop control rendered by PaneContent; on the mobile shell the
  // launcher owns a touch-sized visible close so Escape-less phones can
  // dismiss the overlay. Only the overlay variant (agentLauncherPaneId set)
  // renders it — the empty-pane launcher IS the pane content, hiding it would
  // be a no-op.
  const isOverlayLauncher = useWorkspaceStore((s) => s.agentLauncherPaneId === paneId)
  const mobileBottomInset =
    isMobileShell && osk.isOskOpen && osk.keyboardHeight > 0
      ? `calc(${osk.keyboardHeight}px + 0.5rem)`
      : undefined

  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col items-center justify-center overflow-x-hidden overflow-y-auto p-4 sm:p-8',
        isMobileShell && 'justify-end pb-[max(1.5rem,env(safe-area-inset-bottom))]',
        className
      )}
      style={mobileBottomInset ? { paddingBottom: mobileBottomInset } : undefined}
    >
      {isMobileShell && isOverlayLauncher && (
        <button
          type="button"
          className="absolute right-2 top-2 z-20 flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          aria-label="Close agent launcher"
          title="Close agent launcher"
          onClick={() => useWorkspaceStore.getState().hideAgentLauncher()}
        >
          <X size={22} />
        </button>
      )}
      <div
        className={cn(
          'mb-8 flex w-full flex-col items-center gap-4 text-center',
          isMobileShell && 'mb-4 gap-2'
        )}
      >
        <TermulMark size={isMobileShell ? 32 : 48} className="text-foreground" />
        <h1
          className={cn(
            'break-words text-3xl font-medium tracking-tight text-foreground md:text-4xl',
            isMobileShell && 'text-xl'
          )}
        >
          {`What should we do in ${projectLabel}?`}
        </h1>
      </div>

      <div className="flex min-w-0 w-full max-w-4xl flex-col gap-4">
        <div className="relative">
          {slashOpen && (
            <SlashCommandMenu
              ref={menuRef}
              sections={slashSections}
              onSelect={handleSelect}
              inputRef={composerInputRef}
            />
          )}
          {mentionMenuOpen && (
            <FileMentionMenu
              ref={mentionMenuRef}
              sections={mentionSections}
              onSelect={onMentionSelect}
              emptyLabel={emptyLabel}
              inputRef={composerInputRef}
            />
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for attachments; the file picker button is the accessible path */}
          <div
            data-agent-launcher-composer="true"
            className={cn(
              'relative z-10 rounded-2xl border border-border/60 bg-card transition-colors focus-within:border-border',
              dragActive && 'border-primary/70'
            )}
            onDragEnter={dropProps.onDragEnter}
            onDragLeave={dropProps.onDragLeave}
            onDragOver={dropProps.onDragOver}
            onDrop={dropProps.onDrop}
          >
            {dragActive && canDropPaste && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/80 text-sm font-medium text-foreground backdrop-blur-sm">
                <span className="flex items-center gap-2">
                  <Paperclip size={16} /> Drop files to attach
                </span>
              </div>
            )}
            {selectedEntry?.status === 'install-required' && !manualInstallContext && (
              <InstallRequiredBanner
                entry={selectedEntry}
                installing={installingConfigId === selectedEntry.configId}
                onInstall={() => void handleInstallAgent(selectedEntry)}
                onUseCustomPath={
                  selectedInstall?.kind === 'archive'
                    ? () =>
                        setManualInstallOverride({
                          cmd: selectedInstall.cmd,
                          args: selectedInstall.args,
                          env: selectedInstall.env
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
            {selectedEntry?.status === 'manual-install' &&
              !manualInstallContext &&
              agentPolicy(selectedEntry.id).install.kind === 'managed-npm' && (
                <div className="border-b border-border/60 px-5 py-3 text-xs text-muted-foreground">
                  {selectedEntry.unavailableReason}
                </div>
              )}
            {prepareError &&
              (prepareError.category === 'auth' || prepareError.category === 'multi-auth') && (
                <AuthRequiredBanner
                  agentName={selectedEntry?.agent.name ?? 'Agent'}
                  setupError={prepareError}
                  authMethods={authMethods}
                  signingInMethodId={signingInMethodId}
                  onAuthenticate={handleAuthMethod}
                  onRetry={handleRetryPrepare}
                />
              )}
            {factoryKeyAuth.showKeyInput && inlineKeyMethodId ? (
              <FactoryApiKeyForm auth={factoryKeyAuth} />
            ) : null}
            {/* Story 11 (QA F12/F9): non-auth prepare failures (spawn /
                transport / timeout) previously surfaced only as a "Setup
                failed" pill with Retry buried inside the model-picker modal.
                Render them in-flow above the composer — same pattern as
                AuthRequiredBanner — with a Retry that re-runs prepare. */}
            {prepareError &&
              (prepareError.category === 'spawn' ||
                prepareError.category === 'transport' ||
                prepareError.category === 'timeout') && (
                <NonAuthFailureBanner
                  agentName={selectedEntry?.agent.name ?? 'Agent'}
                  setupError={prepareError}
                  onRetry={handleRetryPrepare}
                />
              )}
            <AttachmentPreviewGroup
              attachments={attachments}
              onRemove={removeAttachment}
              className="px-5 pt-4"
            />
            <div className="relative px-5 pb-2 pt-4">
              {/* Tiptap rich-text editor — the skill "pill" is a real inline
                   DOM node, so the caret sits flush against the pill's right
                   edge by construction. No transparent textarea + mirror
                   overlay, no canvas padding. The `prompt` string (sentinel-token
                   format) is the shared model the wire builder + first-turn
                   sync + timeline consume (byte-identical wire payload). */}
              <ChatComposerEditor
                value={prompt}
                onValueChange={setPrompt}
                onCaretChange={mentions.update}
                onBeforeEditorKeyDown={handleKeyDown}
                onPasteAttachments={handlePaste}
                getSkillPaths={() => skillPathsRef.current}
                editorRef={editorRef}
                inputRef={composerInputRef}
                disabled={composerDisabled}
                minHeight={76}
                maxHeight={160}
                placeholder={
                  hasCommandToken
                    ? 'Add a message (optional)…'
                    : 'Ask anything… (/ for commands, @ for files)'
                }
                ariaLabel="Agent prompt"
                autoFocus
              />
              {/* Tiptap's `Placeholder` extension is configured with
                  `showOnlyWhenEditable: true` (ChatComposerEditor.tsx:237-240),
                  so it suppresses the `data-placeholder` decoration when the
                  editor is non-editable. The `composerDisabled` branch
                  (install-required / saving) would therefore paint nothing.
                  Render an explicit muted hint so the user sees why the
                  composer is inert. Mirrors the editable-state placeholder's
                  text-base/pointer-fine:text-sm/leading-relaxed/muted-foreground styling. */}
              {composerDisabled && (
                <p className="pointer-events-none absolute left-5 top-4 m-0 text-base leading-relaxed text-muted-foreground pointer-fine:text-sm">
                  Composer unavailable
                </p>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 px-3 pb-3">
              <div className="flex min-w-0 items-center gap-2">
                <AttachFilesButton
                  onClick={() => void pickFiles()}
                  disabled={!canPick}
                  className={isMobileShell ? 'size-11' : undefined}
                />
                <McpBadge
                  count={mcpCount}
                  servers={mcpServers}
                  onToggle={(id, enabled) => {
                    void setMcpServerEnabled(id, enabled)
                      .then(() => {
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
                  probeError={mcpProbeError}
                  tools={mcpTools}
                  onLoadTools={(id) => {
                    void loadMcpTools(id)
                  }}
                />
              </div>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2.5">
                {selectedEntry && (selectedUpdateAgent || pendingRestartVersion) && (
                  // One CTA communicates the full lifecycle: Update → Updating
                  // → Restart. The Restart action opens a new chat on the new
                  // version; currently open chats are deliberately preserved.
                  <AgentUpdateCta
                    agentName={selectedEntry.config?.name ?? selectedEntry.agent.name}
                    version={pendingRestartVersion ?? selectedUpdateAgent?.version ?? ''}
                    updating={updatingSelected}
                    restarting={restartingUpdatedAgent}
                    restartAvailable={pendingRestartVersion !== null}
                    onUpdate={handleSelectedAgentUpdate}
                    onRestart={handleRestartUpdatedAgent}
                  />
                )}
                <AcpAgentPicker
                  agents={supportedAgents}
                  selectedEntry={selectedEntry}
                  selectedConfig={selectedConfig}
                  disabled={Boolean(installingConfigId) || savingManualPath}
                  installingConfigId={installingConfigId}
                  updateAgentIds={updateAgentIds}
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
                    'flex shrink-0 items-center justify-center rounded-lg transition-colors',
                    isMobileShell ? 'relative size-11' : 'relative size-10',
                    canLaunch
                      ? 'bg-foreground text-background hover:bg-foreground/90'
                      : 'cursor-not-allowed bg-muted text-muted-foreground'
                  )}
                  aria-label="Start agent chat"
                  title="Start agent chat"
                >
                  <ArrowUp size={isMobileShell ? 20 : 18} />
                </button>
              </div>
            </div>
          </div>
          {canUseWorktree && (
            <div
              data-agent-launcher-context-strip="true"
              className="relative z-0 mx-auto -mt-4 flex w-[calc(100%-2.75rem)] min-w-0 items-center justify-between gap-2 rounded-b-2xl border border-t-0 border-border/60 bg-card/60 px-2 pb-1 pt-5"
            >
              <Select
                value={isolationMode}
                onValueChange={(value) =>
                  value === 'current' || value === 'worktree' ? setIsolationMode(value) : undefined
                }
              >
                <SelectTrigger aria-label="Isolation mode" className={STRIP_TRIGGER_CLASS}>
                  {isolationMode === 'worktree' ? (
                    <FolderGit2 className="size-3.5 shrink-0" />
                  ) : (
                    <Folder className="size-3.5 shrink-0" />
                  )}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current" className={STRIP_MENU_ITEM_CLASS}>
                    Local
                  </SelectItem>
                  <SelectItem value="worktree" className={STRIP_MENU_ITEM_CLASS}>
                    New worktree
                  </SelectItem>
                </SelectContent>
              </Select>

              {isolationMode === 'worktree' && (
                <div className="flex min-w-0 items-center justify-end gap-2">
                  {!baseBranch && baseBranchInfo?.isDetached && (
                    <span className="truncate text-xs text-destructive">
                      Detached HEAD - pick a base
                    </span>
                  )}
                  <Select value={baseBranch ?? ''} onValueChange={(value) => setBaseBranch(value)}>
                    <SelectTrigger
                      aria-label="Base branch"
                      className={cn(STRIP_TRIGGER_CLASS, 'min-w-0 [&>span]:truncate')}
                    >
                      <GitBranch className="size-3.5 shrink-0" />
                      <SelectValue placeholder="Base branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {baseOptions.map((opt) => (
                        <SelectItem
                          key={opt.value}
                          value={opt.value}
                          className={STRIP_MENU_ITEM_CLASS}
                        >
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
