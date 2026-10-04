import type { LastSelectedAgent, PersistedComposerOptions } from '@shared/types/persistence.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import type { Editor } from '@tiptap/core'
import { useIsPresent, useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useSelectedAgentUpdate } from '@/components/agents/launcher/AgentUpdateCta'
import {
  EMPTY_AUTH_METHODS,
  EMPTY_COMMANDS,
  EMPTY_MCP_SERVERS,
  EMPTY_MCP_TOOLS,
  EMPTY_PROBE_ERROR,
  EMPTY_PROBE_STATUS
} from '@/components/agents/launcher/constants'
import { LauncherContextStrip } from '@/components/agents/launcher/context-strip'
import { useFactoryKeyAuth } from '@/components/agents/launcher/FactoryApiKeyForm'
import { LauncherHero } from '@/components/agents/launcher/hero'
import {
  LAUNCHER_DISMISS_MS,
  LAUNCHER_DOCK_BOTTOM_PX,
  LAUNCHER_DOCK_SLIDE_MS,
  LAUNCHER_EXIT_FADE_DELAY_MS,
  LAUNCHER_EXIT_FADE_MS
} from '@/components/agents/launcher/launcher-motion'
import {
  type LauncherExitAnim,
  LauncherOverlayChrome
} from '@/components/agents/launcher/overlay-chrome'
import { prepareLaunchWorktree } from '@/components/agents/launcher/prepare-launch-worktree'
import { spawnAcpLoginTerminal } from '@/components/agents/launcher/spawn-acp-login-terminal'
import { LauncherStatusBanners } from '@/components/agents/launcher/status-banners'
import { LauncherToolbar } from '@/components/agents/launcher/toolbar'
import { useServerAdmitsRemoteWrites } from '@/components/agents/launcher/use-server-admits-remote-writes'
import {
  emptyPendingLauncherOptions,
  hasPendingLauncherOptions,
  optionsToPending,
  overlayPendingLauncherOptions,
  type PendingLauncherOptions
} from '@/components/agents/pending-launcher-options'
import { AttachmentPreviewGroup } from '@/components/chat/AttachmentPreviewGroup'
import { attachmentToBlock, dedupeAttachmentBlocks } from '@/components/chat/chat-attachments'
import {
  extractFastModeOption,
  filterDuplicateModeConfigOptions,
  partitionConfigOptions,
  resolveModelOption
} from '@/components/chat/chat-input-bar-config'
import { ChatComposerEditor } from '@/components/chat/composer/ChatComposerEditor'
import { FileMentionMenu } from '@/components/chat/FileMentionMenu'
import { SlashCommandMenu, type SlashMenuHandle } from '@/components/chat/SlashCommandMenu'
import { useChatComposer } from '@/components/chat/use-chat-composer'
import { useComposerAttachments } from '@/components/chat/use-composer-attachments'
import {
  useComposerCaretRestore,
  useComposerMentionSelect
} from '@/components/chat/use-composer-caret-restore'
import { useComposerMentions } from '@/components/chat/use-composer-mentions'
import { Paperclip } from '@/components/icons'
import { useAcpRegistryCatalog } from '@/hooks/use-acp-registry-catalog'
import { useAgentSkills } from '@/hooks/use-agent-skills'
import { useAttachmentDropZone } from '@/hooks/use-attachment-drop-zone'
import { useMentionRecents } from '@/hooks/use-mention-recents'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useOskViewport } from '@/hooks/use-osk-viewport'
import { useResolvedSupportedAcpAgents } from '@/hooks/use-resolved-supported-acp-agents'
import { type AuthMethod, acpApi, type ContentBlock } from '@/lib/acp-api'
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
import { isTauriContext } from '@/lib/tauri-runtime'
import { platform as osPlatform } from '@/lib/tauri-os'
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
import { agentChatTabId, findPaneById, useWorkspaceStore } from '@/stores/workspace-store'
import { useWorktreeProgressStore } from '@/stores/worktree-progress-store'

interface AgentLauncherProps {
  paneId: string
  className?: string
}

/** Survives overlay unmount so the new-thread picker does not flash the default. */
let cachedConfigId: string | null = null

/** Test-only: clear the cross-unmount selection cache. */
export function __resetLauncherSelectionCache(): void {
  cachedConfigId = null
}

/**
 * Agent launcher surface for a pane — hero + launch composer. Rendered either
 * as empty-pane content or as the Ctrl+T overlay; when a launch hands off to
 * a chat tab it morphs its composer onto the live ChatInputBar card, and when
 * dismissed without a launch it fades in place.
 */
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

  // Launcher→chat handoff: while the AnimatePresence boundary in PaneContent
  // holds this unmounting launcher for the exit window, the hero dissolves
  // upward and the composer card FLIP-morphs onto the real ChatInputBar card
  // that just mounted in this pane (measured by rect, not by constants) — the
  // launcher's own delayed root fade then crossfades the dove card into the
  // live composer. When the launcher is dismissed WITHOUT a launch (Escape /
  // close, or a non-chat tab taking over the pane) nothing morphs: it fades
  // in place. Outside a presence boundary `useIsPresent` stays true, so none
  // of this runs.
  const isPresent = useIsPresent()
  const isExiting = !isPresent
  const reducedMotion = useReducedMotion() ?? false
  const rootRef = useRef<HTMLDivElement | null>(null)
  const composerCardRef = useRef<HTMLDivElement | null>(null)

  // Warm the lazily-loaded chat chunk so the real ChatInputBar exists by the
  // time a launch handoff measures it — otherwise the Suspense skeleton
  // stands in and the morph falls back to the constant dock estimate.
  useEffect(() => {
    void import('@/components/chat/AgentChatPanel')
  }, [])

  // Exit classification needs the pane's active tab BEFORE vs AT the exit:
  // a fresh agent-chat tab becoming active means launch.
  const paneLeaf = useWorkspaceStore((s) => {
    const node = findPaneById(s.root, paneId)
    return node?.type === 'leaf' ? node : null
  })
  const isOverlayLauncher = useWorkspaceStore((s) => s.agentLauncherPaneId === paneId)
  const prevActiveTabIdRef = useRef<string | null | undefined>(paneLeaf?.activeTabId)
  // `hideAgentLauncher` clears agentLauncherPaneId in the same commit the
  // exit starts, so `isOverlayLauncher` already reads false in the exiting
  // render — keep the overlay chrome (backdrop + close) this instance was
  // mounted with through the whole exit.
  const overlayVariantRef = useRef(isOverlayLauncher)
  useEffect(() => {
    if (isPresent) {
      prevActiveTabIdRef.current = paneLeaf?.activeTabId ?? null
      overlayVariantRef.current = isOverlayLauncher
    }
  }, [isPresent, paneLeaf, isOverlayLauncher])
  const showOverlayChrome = isOverlayLauncher || (isExiting && overlayVariantRef.current)

  const [exitAnim, setExitAnim] = useState<LauncherExitAnim | null>(null)
  const exitMeasuredRef = useRef(false)

  // Presence can resume inside the same boundary (overlay hidden → re-shown
  // while still exiting): drop stale exit styling and re-arm measurement.
  useLayoutEffect(() => {
    if (!isPresent) return
    setExitAnim(null)
    exitMeasuredRef.current = false
  }, [isPresent])

  // Measure once on the first exiting commit, while the transform is still
  // identity: the getBoundingClientRect reflow anchors that computed value so
  // the follow-up render animates identity → morph instead of jumping. The
  // once-guard also stops paneLeaf churn mid-exit from re-measuring the
  // already-transformed card (rects include transforms → wrong math).
  useLayoutEffect(() => {
    if (!isExiting || reducedMotion || exitMeasuredRef.current) return
    const root = rootRef.current
    const card = composerCardRef.current
    if (!root || !card) return
    exitMeasuredRef.current = true

    const activeTab = paneLeaf?.tabs.find((t) => t.id === paneLeaf.activeTabId)
    const launched =
      launchInFlightRef.current ||
      (activeTab?.type === 'agent-chat' && activeTab.id !== prevActiveTabIdRef.current)
    if (!launched) {
      setExitAnim({ kind: 'dismiss' })
      return
    }

    // Morph target: the real ChatInputBar card mounted by the fresh chat tab
    // in the same pane. Inactive chat tabs stay mounted (invisible but laid
    // out) and their composers can differ in height — prefer the composer in
    // the ACTIVE tab, then any non-invisible one.
    const paneEl = root.closest('[data-pane-content]')
    const candidates = paneEl
      ? Array.from(paneEl.querySelectorAll<HTMLElement>('[data-chat-composer="true"]'))
      : []
    const target =
      candidates.find((el) => el.closest('[data-chat-tab-state="visible"]') !== null) ??
      candidates.find((el) => el.closest('.invisible') === null) ??
      candidates[0] ??
      null
    const group = card.parentElement ?? card
    const t = target?.getBoundingClientRect()
    const g = group.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    if (!t || t.width <= 0 || t.height <= 0 || c.width <= 0 || c.height <= 0) {
      // Chat composer not laid out yet (lazy chunk / jsdom): keep the
      // constant-distance dock dive as the fallback.
      const distance = root.getBoundingClientRect().bottom - c.bottom - LAUNCHER_DOCK_BOTTOM_PX
      setExitAnim({ kind: 'morph', tx: 0, ty: Math.max(0, distance), sx: 1, sy: 1, ox: 0, oy: 0 })
      return
    }
    // Anchor the card's bottom-center (transform origin in the group's local
    // frame) so the scaled card lands exactly on the target's bottom-center.
    const ox = c.left - g.left + c.width / 2
    const oy = c.bottom - g.top
    setExitAnim({
      kind: 'morph',
      sx: t.width / c.width,
      sy: t.height / c.height,
      ox,
      oy,
      tx: t.left + t.width / 2 - (g.left + ox),
      ty: t.bottom - (g.top + oy)
    })
  }, [isExiting, reducedMotion, paneLeaf])

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
      const store = useAcpStore.getState()
      let launchCwd = projectRoot
      let worktreePath: string | undefined
      let worktreeBranch: string | undefined
      let placeholderId: string | null = null
      let progressId: string | undefined
      try {
        // Honor the same isolation mode as a normal launch. Restart must not
        // silently start the updated agent at the project root when New
        // worktree is selected. Same ordering as `launch`: the chat tab opens
        // first so worktree progress streams into the timeline card.
        if (isolationMode === 'worktree' && canUseWorktree) {
          progressId = randomUUID()
          placeholderId = store.createLaunchPlaceholder({
            cwd: launchCwd,
            projectId: activeProjectId,
            worktreeProgressId: progressId
          })
          useWorkspaceStore.getState().addAgentChatTab(placeholderId, paneId)
          useWorkspaceStore.getState().hideAgentLauncher()
          setWorktreeCreating(true)
          try {
            const prepared = await prepareLaunchWorktree({
              isolationMode,
              canUseWorktree,
              baseBranch,
              projectRoot,
              projectId: activeProjectId,
              progressId
            })
            launchCwd = prepared.launchCwd
            worktreePath = prepared.worktreePath
            worktreeBranch = prepared.worktreeBranch
          } catch (err) {
            useWorkspaceStore.getState().removeTab(agentChatTabId(placeholderId))
            store.discardLaunchPlaceholder(placeholderId)
            useWorktreeProgressStore.getState().clear(progressId)
            useWorkspaceStore.getState().showAgentLauncher(paneId)
            throw err
          } finally {
            setWorktreeCreating(false)
          }
        }
        // Start a fresh session against the updated config. Update Application
        // detaches any process with live chats, so those chats keep running
        // the old version while this new chat uses the applied version.
        if (placeholderId) {
          await store.finalizeChatLaunch({
            placeholderId,
            configId,
            cwd: launchCwd,
            projectId: activeProjectId,
            adoptSession: (from, to) => {
              useWorkspaceStore.getState().remapAgentChatSession(from, to, paneId)
            },
            worktreePath,
            worktreeBranch
          })
        } else {
          const sessionId = await store.startChat(
            configId,
            launchCwd,
            undefined,
            activeProjectId,
            worktreePath || worktreeBranch ? { worktreePath, worktreeBranch } : undefined
          )
          useWorkspaceStore.getState().addAgentChatTab(sessionId, paneId)
          useWorkspaceStore.getState().hideAgentLauncher()
        }
        void logFrontendError({
          level: 'info',
          source: 'agentLauncher.restartUpdatedAgent',
          message: `Started a new ${agentName} chat on version ${version}`
        })
      } catch (err) {
        // spawnAgent can clear the pending marker before createSession
        // finishes. Restore it so Restart stays available after a failed
        // attempt that never opened a chat.
        useAcpStore.setState((s) => ({
          pendingRestartVersions: {
            ...s.pendingRestartVersions,
            [configId]: version
          }
        }))
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
    restartingUpdatedAgent,
    isolationMode,
    canUseWorktree,
    baseBranch
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
    // Issue #840: on web the launcher is the FIRST prewarm path, and it may
    // only ever prewarm a CONFIGURED agent. A merely preselected default
    // (e.g. the catalog-derived Codex `npx` entry shown in the picker before
    // the user picked anything) must not be auto-persisted here and must not
    // seed a warm process — otherwise every page load leaves an `npm exec`
    // tree nobody asked for. Web waits for an explicit user pick (which
    // persists the config first). Desktop keeps the eager persist + warm.
    const hasPersistedConfig = acpConfigs.some((config) => config.id === selectedConfig.id)
    if (!isTauriContext() && !hasPersistedConfig) return
    let cancelled = false
    void (async () => {
      try {
        // Persist a registry-derived config only when no persisted config
        // exists yet. `supportedAgents` refreshes asynchronously after an
        // Update Application, so the selected entry can briefly still carry
        // the old launch args while the store already has the new pin. Never
        // let that stale snapshot overwrite the user's persisted config.
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
    const attachmentsSnapshot = [...attachments]
    const appOwnedPaths = appOwnedTempPaths()
    const modelsSnapshot = effectiveModels
    const modesSnapshot = effectiveModes
    const configOptionsSnapshot = effectiveConfigOptions
    // The launch payload is the EFFECTIVE DISPLAYED option snapshot, not the
    // unflushed `pendingOptions` queue — that queue drains once picks were
    // applied live to a warm session, and a worktree launch always binds a
    // fresh session. Deriving from the display snapshot keeps the invariant
    // "what you see is what the session gets" independent of which session
    // object ends up owning the chat (or when the flush ran).
    const pendingSnapshot = optionsToPending({
      models: modelsSnapshot,
      modes: modesSnapshot,
      configOptions: configOptionsSnapshot
    })
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

    // CAP-3 ordering update: the chat placeholder opens BEFORE the worktree
    // prepare so `git worktree add`'s stderr lines stream into the in-timeline
    // progress card (keyed by `progressId`) while the checkout runs. The
    // agent's cwd is still the worktree path from the first turn —
    // `finalizeChatLaunch`/`startChat` only run after preparation resolves.
    const progressId = isolationMode === 'worktree' && canUseWorktree ? randomUUID() : undefined
    let worktreePath: string | undefined
    let worktreeBranch: string | undefined
    let launchCwd = projectRootSnapshot

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

    // Open the chat immediately; worktree prepare + ACP spawn/session/send
    // continue in the chat view.
    const store = useAcpStore.getState()
    let sessionId =
      preparedKeySnapshot != null && isolationMode !== 'worktree'
        ? store.claimPreparedChat(preparedKeySnapshot, projectIdSnapshot)
        : null
    let usedPlaceholder = false
    let seededOptimistic = false

    if (!sessionId) {
      sessionId = store.createLaunchPlaceholder({
        cwd: launchCwd,
        projectId: projectIdSnapshot,
        models: modelsSnapshot,
        modes: modesSnapshot,
        configOptions: configOptionsSnapshot,
        initialUserBlocks: syncBlocks.length > 0 ? syncBlocks : undefined,
        worktreeProgressId: progressId
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
        // Worktree mode: prepare the isolated checkout now that the chat tab
        // is open — progress lines stream into the timeline card bound to
        // `progressId`. `startChat` still only runs after this resolves.
        if (progressId) {
          setWorktreeCreating(true)
          try {
            const prepared = await prepareLaunchWorktree({
              isolationMode,
              canUseWorktree,
              baseBranch,
              projectRoot: projectRootSnapshot,
              projectId: projectIdSnapshot,
              progressId
            })
            launchCwd = prepared.launchCwd
            worktreePath = prepared.worktreePath
            worktreeBranch = prepared.worktreeBranch
          } catch (err) {
            // Roll back to the launcher — same end state as the old
            // pre-placeholder failure (tab closes, launcher reappears, toast).
            useWorkspaceStore.getState().removeTab(agentChatTabId(sessionId))
            store.discardLaunchPlaceholder(sessionId)
            useWorktreeProgressStore.getState().clear(progressId)
            useWorkspaceStore.getState().showAgentLauncher(paneSnapshot)
            toast.error(err instanceof Error ? err.message : 'Failed to create worktree')
            return
          } finally {
            setWorktreeCreating(false)
          }
        }
        if (needsSave) {
          await saveAgentConfig(configSnapshot)
        }
        persistSelection(configSnapshot.id)
        // Persist only the user's PICKED values (the not-yet-flushed pending
        // queue), never the displayed snapshot: picks that already flushed to
        // a warm session were persisted at pick time, and persisting
        // untouched agent defaults would pin them as "last picks" forever,
        // masking any future agent-side default change.
        persistComposerOptions(configSnapshot.id, {
          modelId: pendingOptions.modelId,
          modeId: pendingOptions.modeId,
          configValues:
            Object.keys(pendingOptions.configValues).length > 0
              ? pendingOptions.configValues
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
        const pendingPayload = hasPendingLauncherOptions(pendingSnapshot) ? pendingSnapshot : null

        const liveStore = useAcpStore.getState()
        let realId = sessionId
        if (usedPlaceholder) {
          realId = await liveStore.finalizeChatLaunch({
            placeholderId: sessionId,
            configId: configSnapshot.id,
            cwd: launchCwd,
            projectId: projectIdSnapshot,
            mcpServers: undefined,
            pending: pendingPayload,
            initialText: null,
            initialBlocks: wireBlocks.length > 0 ? wireBlocks : null,
            adoptSession: (from, to) => {
              useWorkspaceStore.getState().remapAgentChatSession(from, to, paneSnapshot)
            },
            worktreePath,
            worktreeBranch
          })
        } else {
          await liveStore.applyPendingLauncherOptions(realId, pendingPayload)
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
  // The overlay variant (agentLauncherPaneId set) renders a backdrop + a
  // close control — the empty-pane launcher IS the pane content, so it gets
  // neither. During exit the store value is already cleared, so
  // `showOverlayChrome` (captured above) drives the render instead of
  // reading `isOverlayLauncher` directly.
  const mobileBottomInset =
    isMobileShell && osk.isOskOpen && osk.keyboardHeight > 0
      ? `calc(${osk.keyboardHeight}px + 0.5rem)`
      : undefined

  return (
    <div
      ref={rootRef}
      aria-hidden={isExiting || undefined}
      className={cn(
        'absolute inset-0',
        // The keep-alive wrapper in PaneContent is pointer-events-none so the
        // fresh chat is interactive during the exit; re-enable hits only
        // while this copy is the live one.
        isExiting ? 'pointer-events-none' : 'pointer-events-auto',
        className
      )}
      style={
        isExiting && !reducedMotion && exitAnim !== null
          ? {
              opacity: 0,
              // Morph: hold the launcher's root (which occludes the incoming
              // chat surface) until the composer is about to land, then
              // crossfade into the live composer. Dismiss: fade immediately.
              transition:
                exitAnim.kind === 'morph'
                  ? `opacity ${LAUNCHER_EXIT_FADE_MS}ms ease-out ${LAUNCHER_EXIT_FADE_DELAY_MS}ms`
                  : `opacity ${LAUNCHER_DISMISS_MS}ms ease-out`
            }
          : undefined
      }
    >
      {showOverlayChrome && (
        <LauncherOverlayChrome
          isExiting={isExiting}
          exitAnim={exitAnim}
          isMobileShell={isMobileShell}
        />
      )}
      {/* Scrollable content layer above the static backdrop — the backdrop
          stays pane-pinned at any scroll offset. */}
      <div
        className={cn(
          'absolute inset-0 flex flex-col items-center justify-center overflow-x-hidden overflow-y-auto p-4 sm:p-8',
          isMobileShell && 'justify-end pb-[max(1.5rem,env(safe-area-inset-bottom))]'
        )}
        style={mobileBottomInset ? { paddingBottom: mobileBottomInset } : undefined}
      >
        <LauncherHero
          isMobileShell={isMobileShell}
          isExiting={isExiting}
          reducedMotion={reducedMotion}
          projectLabel={projectLabel}
        />

        <div className="flex min-w-0 w-full max-w-4xl flex-col gap-4">
          <div
            data-agent-launcher-composer-group="true"
            className={cn(
              'relative',
              // In-place dismiss: fade with a slight shrink — no dive toward
              // the dock, since no chat took over.
              isExiting &&
                exitAnim?.kind === 'dismiss' &&
                'opacity-0 scale-[0.98] transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none'
            )}
            style={
              isExiting && exitAnim?.kind === 'morph'
                ? {
                    transform: `translate(${exitAnim.tx}px, ${exitAnim.ty}px) scale(${exitAnim.sx}, ${exitAnim.sy})`,
                    transformOrigin: `${exitAnim.ox}px ${exitAnim.oy}px`,
                    transition: `transform ${LAUNCHER_DOCK_SLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
                    willChange: 'transform'
                  }
                : undefined
            }
          >
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
              ref={composerCardRef}
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
              <LauncherStatusBanners
                selectedEntry={selectedEntry}
                manualInstallContext={manualInstallContext}
                installingConfigId={installingConfigId}
                handleInstallAgent={handleInstallAgent}
                selectedInstall={selectedInstall}
                setManualInstallOverride={setManualInstallOverride}
                manualPath={manualPath}
                savingManualPath={savingManualPath}
                setManualPath={setManualPath}
                handleBrowseManualPath={handleBrowseManualPath}
                handleSaveManualPath={handleSaveManualPath}
                prepareError={prepareError}
                authMethods={authMethods}
                signingInMethodId={signingInMethodId}
                handleAuthMethod={handleAuthMethod}
                handleRetryPrepare={handleRetryPrepare}
                factoryKeyAuth={factoryKeyAuth}
                inlineKeyMethodId={inlineKeyMethodId}
              />
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
              <LauncherToolbar
                pickFiles={pickFiles}
                canPick={canPick}
                isMobileShell={isMobileShell}
                mcpCount={mcpCount}
                mcpServers={mcpServers}
                setMcpServerEnabled={setMcpServerEnabled}
                preparedKey={preparedKey}
                activeConfigId={activeConfigId}
                projectRoot={projectRoot}
                activeProjectId={activeProjectId}
                mcpProbeStatus={mcpProbeStatus}
                mcpProbeError={mcpProbeError}
                mcpTools={mcpTools}
                loadMcpTools={loadMcpTools}
                selectedEntry={selectedEntry}
                selectedUpdateAgent={selectedUpdateAgent}
                pendingRestartVersion={pendingRestartVersion}
                updatingSelected={updatingSelected}
                restartingUpdatedAgent={restartingUpdatedAgent}
                handleSelectedAgentUpdate={handleSelectedAgentUpdate}
                handleRestartUpdatedAgent={handleRestartUpdatedAgent}
                supportedAgents={supportedAgents}
                selectedConfig={selectedConfig}
                installingConfigId={installingConfigId}
                savingManualPath={savingManualPath}
                updateAgentIds={updateAgentIds}
                handleSelectAgent={handleSelectAgent}
                modelOption={modelOption}
                showModelLoading={showModelLoading}
                prepareError={prepareError}
                hasCachedModels={hasCachedModels}
                signInMethod={signInMethod}
                handleSignIn={handleSignIn}
                optionsInteractive={optionsInteractive}
                handleRetryPrepare={handleRetryPrepare}
                handleSetModel={handleSetModel}
                thoughtLevel={thoughtLevel}
                handleSetConfig={handleSetConfig}
                fastMode={fastMode}
                nonFastGenericOptions={nonFastGenericOptions}
                modePreviewSession={modePreviewSession}
                handleSetMode={handleSetMode}
                canLaunch={canLaunch}
                launch={launch}
              />
            </div>
            {canUseWorktree && (
              <LauncherContextStrip
                isolationMode={isolationMode}
                setIsolationMode={setIsolationMode}
                baseBranch={baseBranch}
                setBaseBranch={setBaseBranch}
                baseBranchInfo={baseBranchInfo}
                baseOptions={baseOptions}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
