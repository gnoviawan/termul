import type { LastSelectedAgent, PersistedComposerOptions } from '@shared/types/persistence.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import type { Editor } from '@tiptap/core'
import {
  ArrowUp,
  Check,
  Download,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Loader2
} from 'lucide-react'
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
import { ComposerPill } from '@/components/chat/ComposerPill'
import { attachmentToBlock } from '@/components/chat/chat-attachments'
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
import { isSlashTriggerAny } from '@/components/chat/slash-menu-model'
import { useChatComposer } from '@/components/chat/use-chat-composer'
import { useComposerAttachments } from '@/components/chat/use-composer-attachments'
import {
  useComposerCaretRestore,
  useComposerMentionSelect
} from '@/components/chat/use-composer-caret-restore'
import { useComposerMentions } from '@/components/chat/use-composer-mentions'
import { useOptimisticSelect } from '@/components/chat/use-optimistic-select'
import { TermulMark } from '@/components/TermulMark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useAgentSkills } from '@/hooks/use-agent-skills'
import { useMentionRecents } from '@/hooks/use-mention-recents'
import { useResolvedSupportedAcpAgents } from '@/hooks/use-resolved-supported-acp-agents'
import { runtimeT } from '@/i18n/runtime'
import { useRuntimeTranslation } from '@/i18n/use-runtime-translation'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  type AuthMethod,
  acpApi,
  type ContentBlock,
  type McpToolInfo,
  type ProbeStatus
} from '@/lib/acp-api'
import { normalizeCwdForScope } from '@/lib/acp-history-persistence'
import type { StoredMcpServer } from '@/lib/acp-mcp-persistence'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import { findBundledIconByKey } from '@/lib/agents/agent-icon-catalog'
import { sanitizeInlineAgentSvg } from '@/lib/agents/sanitize-agent-icon'
import {
  filterSupportedAcpAgents,
  installedBinaryConfig,
  manualBinaryConfig,
  pickDefaultSupportedAgent,
  type SupportedAcpAgentEntry,
  type SupportedAcpAgentManualInstall
} from '@/lib/agents/supported-acp-agents'
import { dialogApi, openerApi, persistenceApi } from '@/lib/api'
import { registerSessionTempFiles } from '@/lib/attachment-temp-cleanup'
import { logFrontendError } from '@/lib/log-api'
import { platform as osPlatform } from '@/lib/tauri-os'
import { isLoopbackWebClient } from '@/lib/tauri-runtime'
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

export function AgentLauncher({ paneId, className }: AgentLauncherProps): React.JSX.Element {
  const t = useRuntimeTranslation('agents')
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
  const projectLabel = activeProject?.name ?? t('launcher.folderFallback', 'this folder')
  const projectRoot = activeProjectId ? getDefaultCwdForProject(activeProjectId) : undefined
  const projectIsGitRepo = Boolean(activeProject?.isGitRepo)
  const projectGitBranch = activeProject?.gitBranch ?? null
  // CAP-2: isolation mode + base-branch picker. Worktree mode requires a git
  // repo; the selector is hidden on non-repo projects. CAP — Web worktree
  // parity: the worktree mutation routes now ship over HTTP (`web/worktree_api.rs`)
  // so the launcher's worktree mode picker is no longer gated on `isTauriContext()`
  // alone. The write routes (`/worktree/create` etc.) are loopback-guarded
  // (`check_local_only`), so the picker is gated on `isLoopbackWebClient()` —
  // the desktop (always local) and a loopback web client see it; a non-loopback
  // LAN client does not, avoiding a picker that would fail `FORBIDDEN` at launch.
  const canUseWorktree = projectIsGitRepo && isLoopbackWebClient()
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
  // each other. The launcher calls it without a sessionId (pre-launch, no
  // session exists yet); the store setters call it with a sessionId (and
  // the ephemeral-session guard skips warm-pool seeds).
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
        toast.error(
          t('launcher.errors.setOption', 'Failed to set option: {{error}}', {
            error: String(err)
          })
        )
        throw err
      }
    },
    [preparedSessionId, activeConfigId, t]
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
          throw new Error(
            t('launcher.errors.noModelOption', 'No model option is available for this session')
          )
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
        } catch (err) {
          toast.error(
            t('launcher.errors.setModel', 'Failed to set model: {{error}}', {
              error: String(err)
            })
          )
          throw err
        }
        return
      }
      if (!modelOption) {
        throw new Error(
          t('launcher.errors.noModelOption', 'No model option is available for this session')
        )
      }
      await handleSetConfig(modelOption.id, valueId)
    },
    [handleSetConfig, modelOption, modelSource, preparedSessionId, activeConfigId, t]
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
        toast.error(
          t('launcher.errors.setAgent', 'Failed to set agent: {{error}}', {
            error: String(err)
          })
        )
        throw err
      }
    },
    [preparedSessionId, activeConfigId, t]
  )

  const slashOpen = isSlashTriggerAny(prompt) && !composerDisabled
  // Mention-menu wiring (was in `useComposerTextarea`, now inlined — the
  // textarea is gone; the editor's `onCaretChange` feeds `mentions.update` on
  // natural typing, and `handleSelect`/`onMentionSelect` feed it on
  // programmatic splices).
  const mentionMenuOpen = mentions.menuOpen && !composerDisabled && !slashOpen
  const mentionSections = mentions.sections
  const mentionMenuRef = mentions.menuRef
  const emptyLabel = mentions.loading
    ? t('launcher.searchingFiles', 'Searching files…')
    : t('launcher.noMatchingFiles', 'No matching files.')
  const resetMentions = mentions.reset
  const onMentionSelect = useComposerMentionSelect({
    value: prompt,
    setValue: setPrompt,
    editorRef,
    mentions,
    scheduleRestoreCaret
  })

  const {
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
            if (opt && opt.options.some((o) => o.value === vid)) {
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
      // No-op when re-selecting the same agent — avoids resetting
      // worktree/pending state and overwriting the persisted record.
      if (entry.configId === selectedConfigId) {
        editorRef.current?.commands.focus(undefined, { scrollIntoView: false })
        return
      }
      setManualPath('')
      setManualInstallOverride(null)
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
    [persistSelection, selectedConfigId]
  )

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
        const config = installedBinaryConfig(entry.agent, installed, { env: entry.install.env })
        await saveAgentConfig(config)
        setSelectedConfigId(config.id)
        persistSelection(config.id)
        toast.success(t('launcher.installed', '{{name}} installed', { name: entry.agent.name }))
      } catch (err) {
        toast.error(
          t('launcher.errors.install', 'Failed to install {{name}}: {{error}}', {
            name: entry.agent.name,
            error: String(err)
          })
        )
        setManualInstallOverride({
          cmd: entry.install.cmd,
          args: entry.install.args,
          env: entry.install.env
        })
      } finally {
        setInstallingConfigId(null)
      }
    },
    [installingConfigId, persistSelection, saveAgentConfig, t]
  )

  const handleBrowseManualPath = useCallback(async () => {
    const result = await dialogApi.selectFile({
      title: t('settings.selectExecutable', 'Select ACP agent executable'),
      filters:
        osPlatform() === 'windows' ? [{ name: 'Executable', extensions: ['exe'] }] : undefined
    })
    if (result.success && result.data) {
      setManualPath(result.data)
    }
  }, [t])

  const handleSaveManualPath = useCallback(
    async (entry: SupportedAcpAgentEntry, manual: SupportedAcpAgentManualInstall) => {
      if (savingManualPath) return
      const command = manualPath.trim()
      if (!command) {
        toast.error(
          t('launcher.errors.enterInstalledPath', 'Enter the path to the installed ACP binary.')
        )
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
        toast.success(t('launcher.configured', '{{name}} configured', { name: entry.agent.name }))
      } catch (err) {
        toast.error(
          t('launcher.errors.saveAgent', 'Failed to save {{name}}: {{error}}', {
            name: entry.agent.name,
            error: String(err)
          })
        )
      } finally {
        setSavingManualPath(false)
      }
    },
    [manualPath, persistSelection, saveAgentConfig, savingManualPath, t]
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
        toast.error(
          t(
            'launcher.errors.notConnected',
            'Agent is not connected. Use Retry to reconnect, then sign in again.'
          )
        )
        return
      }
      if (signingInMethodId) return
      setSigningInMethodId(methodId)
      try {
        await useAcpStore.getState().authenticateAgent(liveAgentId, methodId)
        handleRetryPrepare()
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t('launcher.errors.signIn', 'Sign-in failed')
        )
      } finally {
        setSigningInMethodId(null)
      }
    },
    [liveAgentId, signingInMethodId, handleRetryPrepare, t]
  )

  const handleSignIn = useCallback(() => {
    if (!signInMethod) {
      toast.error(
        t('launcher.errors.noSignIn', 'No sign-in method is available for this agent yet.')
      )
      return
    }
    void runAuthenticate(signInMethod.id)
  }, [signInMethod, runAuthenticate, t])

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
          toast.error(
            t('launcher.errors.applyOptions', 'Failed to apply options: {{error}}', {
              error: String(err)
            })
          )
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // Flush once when a prepared session appears; pending is snapshotted above.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [preparedSessionId, pendingOptions, t])

  const launch = useCallback(async () => {
    if (!activeProjectId || !projectRoot) {
      toast.error(t('launcher.errors.noProject', 'No active project'))
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
      toast.error(
        err instanceof Error
          ? err.message
          : t('launcher.errors.startChat', 'Failed to start agent chat')
      )
      launchInFlightRef.current = false
      return
    }
    const { wireWithCommand, displayWithCommand } = parts

    // CAP-3: when worktree mode is selected, create the isolated worktree
    // BEFORE opening the chat placeholder so the agent's cwd is the worktree
    // path from the first turn. Branch is `chat/{id}` (deterministic, id-scoped
    // — collision-retry-friendly). Collision-retry appends `-2` once.
    let worktreePath: string | undefined
    let worktreeBranch: string | undefined
    let launchCwd = projectRootSnapshot
    if (isolationMode === 'worktree' && canUseWorktree) {
      if (!baseBranch) {
        toast.error(t('launcher.errors.pickBase', 'Pick a base branch for the worktree'))
        launchInFlightRef.current = false
        return
      }
      setWorktreeCreating(true)
      try {
        const chatId = crypto.randomUUID().slice(0, 8)
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
              const retryErr = retryResult.success
                ? runtimeT('chat', 'store.unknownError', 'unknown')
                : retryResult.error
              throw new Error(
                runtimeT(
                  'chat',
                  'store.worktreeCreationFailed',
                  'Worktree creation failed: {{error}}',
                  { error: retryErr }
                )
              )
            }
          } else {
            const createErr = createResult.success
              ? runtimeT('chat', 'store.unknownError', 'unknown')
              : createResult.error
            throw new Error(
              runtimeT(
                'chat',
                'store.worktreeCreationFailed',
                'Worktree creation failed: {{error}}',
                { error: createErr }
              )
            )
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
        toast.error(
          err instanceof Error
            ? err.message
            : t('launcher.errors.createWorktree', 'Failed to create worktree')
        )
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
            initialBlocks: blocks.length > 0 ? blocks : null,
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
          if (blocks.length > 0) {
            await liveStore.sendPromptBlocks(realId, blocks, {
              skipUserAppend: seededOptimistic
            })
          }
          liveStore.clearLaunchingSession(realId)
        }
        registerSessionTempFiles(realId, appOwnedPaths)
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : t('launcher.errors.startChat', 'Failed to start agent chat')
        )
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
    baseBranch,
    t
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
      out.push({
        value,
        label: isCurrent
          ? t('launcher.currentBranch', '{{branch}} (current)', { branch: value })
          : value
      })
    }
    add(baseBranchInfo?.currentBranch, true)
    add(baseBranchInfo?.defaultBase)
    add(projectGitBranch, true)
    for (const b of branches) add(b)
    return out
  })()

  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col items-center justify-center overflow-x-hidden p-4 sm:p-8',
        className
      )}
    >
      <div className="mb-8 flex w-full flex-col items-center gap-4 text-center">
        <TermulMark size={48} className="text-foreground" />
        <h1 className="break-words text-3xl font-medium tracking-tight text-foreground md:text-4xl">
          {t('launcher.heading', 'What should we do in {{project}}?', { project: projectLabel })}
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
            className="relative z-10 rounded-2xl border border-border/60 bg-card transition-colors focus-within:border-border"
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
                  t(
                    'launcher.platformUnavailable',
                    'This ACP agent is not available on this platform.'
                  )}
              </div>
            )}
            {prepareError &&
              (prepareError.category === 'auth' || prepareError.category === 'multi-auth') && (
                <AuthRequiredBanner
                  agentName={selectedEntry?.agent.name ?? t('common.agent', 'Agent')}
                  setupError={prepareError}
                  authMethods={authMethods}
                  signingInMethodId={signingInMethodId}
                  onAuthenticate={(methodId) => void runAuthenticate(methodId)}
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
                    ? t('launcher.optionalMessage', 'Add a message (optional)…')
                    : t('launcher.prompt', 'Ask anything.. (@ for files, / for commands)')
                }
                ariaLabel={t('launcher.promptAria', 'Agent prompt')}
                autoFocus
              />
              {/* Tiptap's `Placeholder` extension is configured with
                  `showOnlyWhenEditable: true` (ChatComposerEditor.tsx:237-240),
                  so it suppresses the `data-placeholder` decoration when the
                  editor is non-editable. The `composerDisabled` branch
                  (install-required / saving) would therefore paint nothing.
                  Render an explicit muted hint so the user sees why the
                  composer is inert. Mirrors the editable-state placeholder's
                  text-base/leading-relaxed/muted-foreground styling. */}
              {composerDisabled && (
                <p className="pointer-events-none absolute left-5 top-4 m-0 text-base leading-relaxed text-muted-foreground">
                  {t('launcher.composerUnavailable', 'Composer unavailable')}
                </p>
              )}
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
                          t(
                            'launcher.errors.updateMcp',
                            'Could not update the MCP server. Your previous setting was restored.'
                          )
                        )
                      })
                  }}
                  probeStatus={mcpProbeStatus}
                  probeError={mcpProbeError}
                  tools={mcpTools}
                  onLoadTools={(id) => {
                    void loadMcpTools(id)
                  }}
                  compact
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
                    label={t('common.agent', 'Agent')}
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
                  aria-label={t('launcher.startChat', 'Start agent chat')}
                  title={t('launcher.startChat', 'Start agent chat')}
                >
                  <ArrowUp size={18} />
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
                <SelectTrigger
                  aria-label={t('launcher.isolationMode', 'Isolation mode')}
                  className="h-7 min-h-7 w-auto shrink-0 gap-1.5 border-0 bg-transparent px-2.5 py-0 text-xs font-medium text-muted-foreground/70 hover:bg-accent/40 hover:text-foreground/80 focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=open]:bg-accent/40 [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:opacity-70"
                >
                  {isolationMode === 'worktree' ? (
                    <FolderGit2 className="size-3.5 shrink-0" />
                  ) : (
                    <Folder className="size-3.5 shrink-0" />
                  )}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">{t('common.local', 'Local')}</SelectItem>
                  <SelectItem value="worktree">
                    {t('common.newWorktree', 'New worktree')}
                  </SelectItem>
                </SelectContent>
              </Select>

              {isolationMode === 'worktree' && (
                <div className="flex min-w-0 items-center justify-end gap-2">
                  {!baseBranch && baseBranchInfo?.isDetached && (
                    <span className="truncate text-xs text-destructive">
                      {t('launcher.detachedHead', 'Detached HEAD - pick a base')}
                    </span>
                  )}
                  <Select value={baseBranch ?? ''} onValueChange={(value) => setBaseBranch(value)}>
                    <SelectTrigger
                      aria-label={t('launcher.baseBranch', 'Base branch')}
                      className="h-7 min-h-7 w-auto min-w-0 gap-1.5 border-0 bg-transparent px-2.5 py-0 text-xs font-medium text-muted-foreground/70 hover:bg-accent/40 hover:text-foreground/80 focus:outline-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=open]:bg-accent/40 [&>span]:truncate [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:opacity-70"
                    >
                      <GitBranch className="size-3.5 shrink-0" />
                      <SelectValue placeholder={t('launcher.baseBranch', 'Base branch')} />
                    </SelectTrigger>
                    <SelectContent>
                      {baseOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
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
  const t = useRuntimeTranslation('agents')
  const signingInMethod = authMethods.find((m) => m.id === signingInMethodId)
  const actionableMethods = authMethods.filter((m) => m.id.trim().length > 0)

  return (
    <div className="border-b border-border/60 px-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground">
            {signingInMethod
              ? t('launcher.authenticating', 'Authenticating to {{name}}…', { name: agentName })
              : t('launcher.authenticate', 'Authenticate to {{name}}', { name: agentName })}
          </div>
          <p className="mt-0.5 line-clamp-4 break-words text-xs text-muted-foreground">
            {setupError.detail}
          </p>
          {setupError.category === 'multi-auth' && actionableMethods.length > 1 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                'launcher.chooseAuthentication',
                'Choose one of the following authentication options:'
              )}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {signingInMethod ? (
            <Button type="button" size="sm" disabled>
              <Loader2 size={14} className="mr-1.5 animate-spin" />
              {t('launcher.signingIn', 'Signing in with {{method}}…', {
                method: signingInMethod.name
              })}
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
              {t('common.retry', 'Retry')}
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
  const t = useRuntimeTranslation('agents')
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">
          {t('launcher.installRequired', 'Install required')}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t(
            'launcher.installRequiredDescription',
            '{{name}} needs a local ACP binary before it can start chats.',
            { name: entry.agent.name }
          )}
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
            {t('launcher.customPath', 'Custom path')}
          </Button>
        )}
        <Button type="button" size="sm" disabled={installing} onClick={onInstall}>
          {installing ? (
            <Loader2 size={14} className="mr-1.5 animate-spin" />
          ) : (
            <Download size={14} className="mr-1.5" />
          )}
          {installing ? t('common.installing', 'Installing…') : t('common.install', 'Install')}
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
  const t = useRuntimeTranslation('agents')
  const launcher = entry.runtimeLauncher ?? 'npx'
  const helpUrl = RUNTIME_HELP_URLS[launcher]
  const helpLabel =
    launcher === 'uvx'
      ? t('launcher.installUv', 'Install uv')
      : t('launcher.installNode', 'Install Node.js')

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">
          {t('launcher.runtimeRequired', 'Runtime required')}
        </div>
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
  const t = useRuntimeTranslation('agents')
  const expectedCommand = `${manual.cmd}${manual.args.length > 0 ? ` ${manual.args.join(' ')}` : ''}`

  return (
    <div className="space-y-3 border-b border-border/60 px-5 py-3">
      <div>
        <div className="text-xs font-medium text-foreground">
          {t('launcher.manualInstall', 'Manual install')}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {entry.unavailableReason ??
            t(
              'launcher.manualInstallDescription',
              'Install {{name}} from the vendor, then point Termul at the binary.',
              { name: entry.agent.name }
            )}
        </p>
        {expectedCommand && (
          <p className="mt-1 font-mono text-2xs text-muted-foreground">
            {t('launcher.expectedCommand', 'Expected: {{command}}', {
              command: expectedCommand
            })}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={path}
          onChange={(event) => onPathChange(event.target.value)}
          placeholder={t('launcher.pathPlaceholder', 'Path to installed ACP binary')}
          aria-label={t('launcher.pathAria', 'ACP agent executable path')}
          className="h-8 font-mono text-xs"
          disabled={saving}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={onBrowse}
          aria-label={t('launcher.browsePathAria', 'Browse for ACP agent executable')}
        >
          <FolderOpen size={14} />
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saving || path.trim().length === 0}
          onClick={onSave}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : t('common.save', 'Save')}
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
  const t = useRuntimeTranslation('agents')
  const [query, setQuery] = useState('')
  const visibleAgents = useMemo(() => filterSupportedAcpAgents(agents, query), [agents, query])
  const rawLabel =
    selectedConfig?.name ?? selectedEntry?.agent.name ?? t('launcher.agentPicker', 'ACP Agent')
  const label = rawLabel.endsWith(' CLI') ? rawLabel.slice(0, -4) : rawLabel
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <ComposerPill
          disabled={disabled}
          aria-label={t('launcher.selectAgent', 'Select ACP agent: {{name}}', { name: label })}
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
          {t('launcher.agentPicker', 'ACP Agent')}
        </div>
        <div className="px-2 pb-1">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('launcher.searchAgents', 'Search agents…')}
            aria-label={t('launcher.searchAgentsAria', 'Search ACP agents')}
            className="h-7 text-xs"
          />
        </div>
        <div className="max-h-64 overflow-y-auto pr-1">
          {visibleAgents.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {t('launcher.noAgents', 'No agents match.')}
            </div>
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
                    {installingConfigId === entry.configId
                      ? t('common.installing', 'Installing…')
                      : t('common.install', 'Install')}
                  </span>
                )}
                {entry.status === 'needs-runtime' && (
                  <span className="text-3xs text-muted-foreground">
                    {entry.runtimeLauncher === 'uvx'
                      ? t('launcher.needsUv', 'Needs uv')
                      : t('launcher.needsNode', 'Needs Node')}
                  </span>
                )}
                {entry.status === 'manual-install' && (
                  <span className="text-3xs text-muted-foreground">
                    {t('common.manualInstall', 'Manual install')}
                  </span>
                )}
                {entry.status === 'unavailable' && (
                  <span className="text-3xs text-muted-foreground">
                    {t('common.unavailable', 'Unavailable')}
                  </span>
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
  const t = useRuntimeTranslation('agents')
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
    ? t('launcher.loadingModel', 'Loading model…')
    : setupError
      ? setupError.label
      : (currentModel?.name ?? t('common.model', 'Model'))
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
          aria-label={t('launcher.selectModel', 'Select model: {{name}}', { name: label })}
          className={cn('max-w-[220px]', (connecting || stale) && !setupError && 'opacity-80')}
          chevron
          pending={pending || (connecting && !setupError)}
        >
          <span className="truncate">{label}</span>
        </ComposerPill>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-1">
        <div className="px-2 py-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground/70">
          {t('common.model', 'Model')}
          {connecting && !setupError && (
            <span className="ml-1 font-normal normal-case tracking-normal">
              · {t('launcher.connecting', 'Connecting…')}
            </span>
          )}
          {stale && !connecting && !setupError && (
            <span className="ml-1 font-normal normal-case tracking-normal">
              · {t('launcher.cached', 'Cached')}
            </span>
          )}
        </div>
        {selectedEntry?.status !== 'ready' ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {selectedEntry?.status === 'install-required'
              ? t('launcher.installForModels', 'Install this ACP agent to load model options.')
              : selectedEntry?.status === 'needs-runtime'
                ? t(
                    'launcher.runtimeForModels',
                    'Install the required runtime before loading model options.'
                  )
                : selectedEntry?.status === 'manual-install'
                  ? t(
                      'launcher.manualForModels',
                      'Install this agent manually before loading model options.'
                    )
                  : t(
                      'launcher.platformUnavailable',
                      'This ACP agent is not available on this platform.'
                    )}
          </div>
        ) : !setupError && modelOption ? (
          <>
            {showSearch && (
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('launcher.searchModels', 'Search models...')}
                aria-label={t('launcher.searchModels', 'Search models...')}
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
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t('launcher.noModels', 'No matching models.')}
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
                  : t('launcher.loadModelFailed', 'Could not load model options.')}
              </div>
              <div className="mt-1 line-clamp-3 break-words">{setupError.detail}</div>
            </div>
            {setupError.category === 'multi-auth' ? null : setupError.category === 'auth' &&
              signInMethod ? (
              <Button type="button" size="sm" className="h-7 text-xs" onClick={onSignIn}>
                {t('launcher.signIn', 'Sign in with {{method}}', {
                  method: signInMethod.name
                })}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={onRetry}
              >
                {t('common.retry', 'Retry')}
              </Button>
            )}
          </div>
        ) : (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {loading
              ? t('launcher.loadingModelOptions', 'Loading model options…')
              : t(
                  'launcher.noAdvertisedModels',
                  'This ACP agent has not advertised model options.'
                )}
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
