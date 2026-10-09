import type { Editor } from '@tiptap/core'
import { useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Folder, FolderGit2, GitBranch, Paperclip } from '@/components/icons'
import { useAgentSkills } from '@/hooks/use-agent-skills'
import { useAttachmentDropZone } from '@/hooks/use-attachment-drop-zone'
import { useChatIsolationContext } from '@/hooks/use-chat-isolation-context'
import { useMentionRecents } from '@/hooks/use-mention-recents'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useOskViewport } from '@/hooks/use-osk-viewport'
import { useVisibleSnapshot } from '@/hooks/use-visible-snapshot'
import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
  SessionModeState
} from '@/lib/acp-api'
import { registerSessionTempFiles } from '@/lib/attachment-temp-cleanup'
import { cn } from '@/lib/utils'
import type { AcpSession, PendingPermission, QueuedPrompt } from '@/stores/acp-store'
import {
  useAcpMessages,
  useAcpStore,
  useAgentIcon,
  useAgentTemplateId,
  useSessionUsage
} from '@/stores/acp-store'
import { ModeChip } from './AgentHeader'
import { AttachFilesButton } from './AttachFilesButton'
import { AttachmentPreviewGroup } from './AttachmentPreviewGroup'
import { AgentModelSelector } from './agent-model-selector/AgentModelSelector'
import { useCurrentAgentConfigId } from './agent-model-selector/use-agent-switch'
import { ComposerBeamShell } from './ComposerBeamShell'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { attachmentToBlock, dedupeAttachmentBlocks } from './chat-attachments'
import {
  extractFastModeOption,
  filterDuplicateModeConfigOptions,
  partitionConfigOptions,
  resolveModelOption
} from './chat-input-bar-config'
import { CHAT_COMPACT_LABEL, CHAT_GUTTER_X, useComposerToolbarMode } from './chat-layout'
import { ChatComposerEditor } from './composer/ChatComposerEditor'
import { ComposerAddSheet } from './composer/ComposerAddSheet'
import { ComposerSendButton } from './composer/ComposerSendButton'
import { blurComposerEditor, insertComposerTrigger } from './composer/insert-composer-trigger'
import { FileMentionMenu } from './FileMentionMenu'
import { McpBadge } from './McpBadge'
import { PermissionPrompt } from './PermissionPrompt'
import { PromptQueuePanel } from './PromptQueuePanel'
import { SlashCommandMenu, type SlashMenuHandle } from './SlashCommandMenu'
import { useChatComposer } from './use-chat-composer'
import { useComposerAttachments } from './use-composer-attachments'
import { useComposerCaretRestore, useComposerMentionSelect } from './use-composer-caret-restore'
import { useComposerDraft } from './use-composer-draft'
import { useComposerMentions } from './use-composer-mentions'

interface ChatInputBarProps {
  /** Active session — drives selector chips. */
  session: AcpSession
  /** Project/worktree root used to discover project-local skills. */
  projectRoot?: string
  /** Whether a prompt turn is currently active (disables send, enables cancel). */
  busy: boolean
  /** Whether the session is closed/disconnected (fully disables input). */
  disabled: boolean
  /** Whether the agent accepts inline image content blocks (drag/paste images). */
  imageCapable?: boolean
  /** Whether the agent accepts embedded `resource` blocks (drag/paste text files). */
  embedCapable?: boolean
  onSend: (text: string) => void
  /**
   * Send a prompt carrying structured content blocks (text + attachments).
   * The first arg is the wire text dispatched to the agent; the optional second
   * arg is the display blocks stored in the optimistic user message so the
   * timeline can render inline skill chips (token text) while the agent
   * receives the path-based wire framing. When omitted, the wire blocks are
   * also used for display.
   */
  onSendBlocks: (blocks: ContentBlock[], displayBlocks?: ContentBlock[]) => void
  onCancel: () => void
  /** Slash-menu data sources from the active session. */
  commands: AvailableCommand[]
  configOptions: SessionConfigOption[]
  modes: SessionModeState | null
  /** Apply a config option value immediately. May return a Promise for chip pending UI. */
  onSetConfig: (configId: string, valueId: string | boolean) => void | Promise<void>
  /** Apply a legacy mode immediately. May return a Promise for chip pending UI. */
  onSetMode: (modeId: string) => void | Promise<void>
  /** Apply a native ACP model selection immediately. May return a Promise for chip pending UI. */
  onSetModel: (modelId: string) => void | Promise<void>
  /** External text to load into the composer (edit a message / pick a suggestion). */
  seedText?: string
  /** Bump to re-apply `seedText` even if the text is unchanged. */
  seedNonce?: number
  /** Pending prompts shown above the composer. */
  queue?: QueuedPrompt[]
  /** Approval request currently waiting for the user. */
  permission?: PendingPermission | null
  onRemoveQueued?: (queueId: string) => void
  onSendQueuedNow?: (queueId: string) => void
  /** When true, removes top padding so the changed-files panel sits flush behind the chatbox. */
  compactTop?: boolean
  /**
   * Whether the host chat panel's tab is the pane's active tab. While false,
   * the per-flush `useAcpMessages` re-render is frozen (same render gate as
   * AgentChatPanel): the subscription stays live, but the derived value holds
   * its last-visible snapshot so a hidden panel's composer does no per-flush
   * work. Defaults to true (visible) for other hosts.
   */
  isVisible?: boolean
}

export function ChatInputBar({
  session,
  projectRoot,
  busy,
  disabled,
  imageCapable = false,
  embedCapable = false,
  onSend,
  onSendBlocks,
  onCancel,
  commands,
  configOptions,
  modes,
  onSetConfig,
  onSetMode,
  onSetModel,
  seedText,
  seedNonce,
  queue = [],
  permission,
  onRemoveQueued,
  onSendQueuedNow,
  compactTop = false,
  isVisible = true
}: ChatInputBarProps): React.JSX.Element {
  const usableConfigOptions = configOptions.filter(
    (option) => option.type === 'boolean' || (option.options?.length ?? 0) > 0
  )
  // CAP-6: worktree/branch indicator, shared with the mobile shell subtitle.
  const { isWorktree, isolationModeLabel, isolationModeTitle, isolationBranch, isDetachedHead } =
    useChatIsolationContext({
      projectId: session.projectId,
      worktreePath: session.worktreePath,
      worktreeBranch: session.worktreeBranch
    })
  const {
    model,
    thoughtLevel,
    modelConfig,
    rest: genericConfigOptions
  } = partitionConfigOptions(usableConfigOptions)
  const { option: modelOption, source: modelSource } = resolveModelOption(model, session.models)
  const visibleGenericConfigOptions = filterDuplicateModeConfigOptions(genericConfigOptions, modes)
  const { fastMode, rest: nonFastGenericOptions } = extractFastModeOption(
    visibleGenericConfigOptions
  )
  const { skills: availableSkills } = useAgentSkills(projectRoot ?? session.cwd)
  const sessionUsage = useSessionUsage(session.id)
  // Render gate (multi-project perf): the live subscription stays, but the
  // derived value freezes while the host panel is hidden (the composer only
  // reads `messages` for the context-usage ring's bootstrap filter).
  const messages = useVisibleSnapshot(isVisible, useAcpMessages(session.id))
  // Armed agent switch: the composer's chips advertise the TARGET config's
  // options (armedOptions overlay in AgentChatPanel), so the glyph must too —
  // resolving by the session's live `agentId` keeps the OLD agent's icon
  // (Devin) while the model list already shows the target's (OpenCode).
  // Read `switching` from the store (not the prop) — the same field the
  // model selector reads — so the icon flips the moment the arm lands.
  const armedConfigId = useAcpStore((s) => s.sessions?.[session.id]?.switching?.toConfigId)
  // Names the mode menu's "Let <agent> act" group: the armed target while a
  // switch is armed (the menu then lists the target's modes), else this chat's agent.
  const currentAgentConfigId = useCurrentAgentConfigId(session.id)
  const modeAgentName = useAcpStore(
    (s) => s.agentConfigs?.find((c) => c.id === (armedConfigId ?? currentAgentConfigId))?.name
  )
  const agentTemplateId = useAgentTemplateId(session.agentId, armedConfigId)
  const agentIcon = useAgentIcon(session.agentId, armedConfigId)
  // Prefer project/session-scoped MCP context. Older/local sessions without a
  // recorded count retain the existing global-registry fallback.
  const globalMcpCount = useAcpStore((s) => s.mcpServers.length)
  const mcpCount = session.mcpServerCount ?? globalMcpCount
  // Chatbox popover (per-server enable/disable + status dot + collapsible tool
  // list). The badge degrades to the read-only count pill when the registry is
  // empty. Reuses `setMcpServerEnabled` (optimistic + rollback) — no new
  // persistence path. The probe reflects Termul's own client connection.
  const mcpServers = useAcpStore((s) => s.mcpServers)
  const setMcpServerEnabled = useAcpStore((s) => s.setMcpServerEnabled)
  const mcpProbeStatus = useAcpStore((s) => s.mcpProbeStatus)
  const mcpProbeError = useAcpStore((s) => s.mcpProbeError)
  const mcpTools = useAcpStore((s) => s.mcpTools)
  const loadMcpTools = useAcpStore((s) => s.loadMcpTools)
  const [value, setValue] = useComposerDraft({
    projectId: session.projectId,
    sessionId: session.id,
    seedNonce
  })
  const [sending, setSending] = useState(false)
  const reduced = useReducedMotion() ?? false
  // Story 5.3: OSK awareness on mobile web. On Tauri desktop, the hook returns
  // a no-OSK default (no `visualViewport` thrash — desktop non-regression).
  const osk = useOskViewport()
  const isMobileShell = useMobileWebShell()
  // OSK-open transition: scroll the textarea into view exactly once per
  // OSK-open window. The OSK state can lag the focus event (focus fires
  // before `osk.isOskOpen` flips true), so a closed→open transition effect
  // is more reliable than reading `osk.isOskOpen` in onFocus.
  const prevOskOpenRef = useRef(false)
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
  } = useComposerAttachments({ imageCapable, embedCapable, disabled })
  // Drag feedback for the attachment drop zone (shared with AgentLauncher):
  // depth-counted dragenter/dragleave pairs; the overlay stays local.
  const { dragActive, dropProps } = useAttachmentDropZone({ canDropPaste, addFiles })
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarMode = useComposerToolbarMode(rootRef)
  const editorRef = useRef<Editor | null>(null)
  const composerInputRef = useRef<HTMLElement | null>(null)
  const { scheduleRestoreCaret } = useComposerCaretRestore(editorRef)
  const slashMenuRef = useRef<SlashMenuHandle>(null)
  const { recents: mentionRecents, pushRecent: pushMentionRecent } = useMentionRecents(
    session.projectId,
    session.cwd
  )
  const mentions = useComposerMentions({
    rootPath: session.cwd,
    disabled,
    recents: mentionRecents,
    onStageFileRef: (m) => {
      pushMentionRecent(m)
    }
  })

  // Mention-menu wiring (was in `useComposerTextarea`, now inlined — the
  // textarea is gone; the editor's `onCaretChange` feeds `mentions.update` on
  // natural typing, and `handleSelect`/`onMentionSelect` feed it on
  // programmatic splices). `onMentionSelect` restores the caret via the editor.
  // `mentions` is a new object each render (useComposerMentions returns a fresh
  // literal), so effects that depend on it would re-fire every render and loop
  // (the seed effect calls `setValue`, which re-renders, which re-fires the
  // effect). Stabilize the `update` access via a ref so effect deps stay
  // stable without lying to the lint rule.
  const mentionsRef = useRef(mentions)
  mentionsRef.current = mentions
  const updateMentionsStable = useCallback((v: string, c: number) => {
    mentionsRef.current.update(v, c)
  }, [])
  const mentionSections = mentions.sections
  const mentionMenuRef = mentions.menuRef
  const emptyLabel = mentions.loading ? 'Searching files…' : 'No files match. Try another name.'
  const resetMentions = mentions.reset
  const onMentionSelect = useComposerMentionSelect({
    value,
    setValue,
    editorRef,
    mentions,
    scheduleRestoreCaret
  })

  const {
    slashOpen: composerSlashOpen,
    slashSections,
    hasCommandToken,
    skillPathsRef,
    handleSelect,
    onSlashOrMentionKeyDown,
    buildPromptParts
  } = useChatComposer({
    value,
    setValue,
    editorRef,
    slashMenuRef,
    commands,
    configOptions,
    modes,
    skills: availableSkills,
    disabled,
    onSetConfig,
    onSetMode,
    onSetModel,
    mentions,
    scheduleRestoreCaret
  })
  const slashOpen = composerSlashOpen
  const mentionMenuOpen = mentions.menuOpen && !disabled && !slashOpen

  const canSend = !disabled && !sending && (value.trim().length > 0 || attachments.length > 0)
  const showStop = busy && !canSend

  const submit = useCallback(async () => {
    const hasAttachments = attachments.length > 0
    const hasText = value.trim().length > 0
    if ((!hasText && !hasAttachments) || disabled || sending) return

    setSending(true)
    try {
      // Build the wire/display text parts from the current value, resolved
      // skill paths, and inline command token. Throws `Skill '<name>' is
      // missing a path` when a selected skill has no resolvable path (Block If)
      // — caught below.
      const {
        hasSkills,
        hasCommand,
        wireWithCommand,
        displayWithCommand,
        wireTrimmed,
        displayTrimmed,
        fileBlocks
      } = buildPromptParts()
      const hasFileRefs = fileBlocks.length > 0
      if (!wireTrimmed && !hasAttachments && !hasFileRefs) return

      if (hasAttachments) {
        const wireBlocks: ContentBlock[] = []
        if (wireTrimmed) wireBlocks.push({ type: 'text', text: wireWithCommand })
        for (const a of attachments) wireBlocks.push(attachmentToBlock(a))
        wireBlocks.push(...fileBlocks)
        const wire = dedupeAttachmentBlocks(wireBlocks)
        // Split display from wire when skills, file-mention pills, OR a
        // command token are present: skills carry framing tokens, file
        // mentions carry inline pill tokens, commands carry the
        // `\uE004<name>\uE005` token — all need the display to keep the raw
        // token text so the timeline renders inline chips. Without either,
        // display == wire.
        if (hasSkills || hasFileRefs || hasCommand) {
          const displayBlocks: ContentBlock[] = []
          if (displayTrimmed) displayBlocks.push({ type: 'text', text: displayWithCommand })
          for (const a of attachments) displayBlocks.push(attachmentToBlock(a))
          const display = dedupeAttachmentBlocks(displayBlocks)
          onSendBlocks(wire, display)
        } else {
          onSendBlocks(wire)
        }
      } else if (hasSkills) {
        // Skills (tokens) present: split display (tokens) from wire (framing).
        // File-mention `resource_link` blocks append to the wire only — the
        // display keeps the raw token text so the timeline renders inline
        // file pills.
        const wireBlocks: ContentBlock[] = wireTrimmed
          ? [{ type: 'text', text: wireWithCommand }]
          : []
        wireBlocks.push(...fileBlocks)
        onSendBlocks(
          dedupeAttachmentBlocks(wireBlocks),
          displayTrimmed ? [{ type: 'text', text: displayWithCommand }] : []
        )
      } else if (hasFileRefs) {
        // File-mention pills present (no skills, no attachments): the wire
        // carries the text (tokens → `(display)`) + `resource_link` blocks for
        // each unique file. Display keeps the token text so the timeline
        // renders inline file pills.
        const wireBlocks: ContentBlock[] = wireTrimmed
          ? [{ type: 'text', text: wireWithCommand }]
          : []
        wireBlocks.push(...fileBlocks)
        onSendBlocks(
          dedupeAttachmentBlocks(wireBlocks),
          displayTrimmed ? [{ type: 'text', text: displayWithCommand }] : []
        )
      } else if (hasCommand) {
        // Command pill present (no skills, files, or attachments): the wire
        // carries the `/<name> ` prefix; the display keeps the raw token text
        // so the timeline renders the command chip. Wire stays byte-identical
        // to the pre-token plain-text path (`wireTrimmed`).
        onSendBlocks(
          wireTrimmed ? [{ type: 'text', text: wireTrimmed }] : [],
          displayTrimmed ? [{ type: 'text', text: displayTrimmed }] : []
        )
      } else {
        // Plain text-only path: display == wire (no separate display blocks).
        onSend(wireTrimmed)
      }
      // Register app-owned temp files (pasted screenshots) with the session so
      // they are deleted when the session closes; clearAttachments drops state
      // without deleting because the agent reads them by path during the turn.
      registerSessionTempFiles(session.id, appOwnedTempPaths())
      setValue('')
      skillPathsRef.current = {}
      clearAttachments()
      resetMentions()
    } catch (err) {
      // Skill path resolution throws a specific user-facing message — keep it.
      const msg = err instanceof Error ? err.message : ''
      toast.error(msg.includes('missing a path') ? msg : 'Could not send your message. Try again.')
    } finally {
      setSending(false)
    }
  }, [
    value,
    attachments,
    disabled,
    sending,
    clearAttachments,
    appOwnedTempPaths,
    onSend,
    onSendBlocks,
    resetMentions,
    session.id,
    buildPromptParts,
    skillPathsRef,
    setValue
  ])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean | undefined => {
      // Editor-first keymap: the slash/mention menu keys + Enter→submit /
      // Escape→cancel run BEFORE the editor's own keymap (Backspace-pill
      // removal is editor-owned). `onSlashOrMentionKeyDown` consumes the
      // slash/mention menu arrows/Tab/Enter/Escape when their menus are open;
      // Enter→submit + Ctrl/Cmd+Enter→submit + Escape→cancel are
      // surface-specific (the running chatbox cancels a busy turn on Escape
      // and morphs send/stop). Ctrl/Cmd+Enter is part of the frozen
      // accessibility baseline (parity with `AgentLauncher`).
      if (onSlashOrMentionKeyDown(event) === true) return true
      if (event.key === 'Escape' && busy) {
        event.preventDefault()
        onCancel()
        return true
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        if (showStop) return true
        void submit()
        return true
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        if (showStop) return true
        void submit()
        return true
      }
      return undefined
    },
    [onSlashOrMentionKeyDown, busy, showStop, onCancel, submit]
  )

  // Load externally-seeded text (edit a message, pick a starter prompt), then
  // focus and place the cursor at the end. Keyed on a nonce so re-picking the
  // same text still applies. The editor re-parses `value` on the next render
  // (its external-sync effect) — the rAF below lands the caret at the end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the intended trigger; `mentions` is read via a stable ref (`updateMentionsStable`) so it doesn't re-fire every render (which would loop via setValue).
  useEffect(() => {
    if (seedNonce === undefined) return
    const next = seedText ?? ''
    setValue(next)
    updateMentionsStable(next, next.length)
    // Shared rAF caret-restore (cancels pending frames, no-ops on destroyed
    // editor) — replaces the bare `requestAnimationFrame` that swallowed
    // throws against a destroyed editor.
    scheduleRestoreCaret(next.length)
  }, [seedNonce, scheduleRestoreCaret, updateMentionsStable, setValue])

  // Story 5.3 (T2.3): on mobile web, scroll the editor into view once per
  // OSK-open window so iOS Safari doesn't leave the input under the keyboard.
  // rAF-deferred to let layout settle; fires once per OSK-open window.
  useEffect(() => {
    const wasOpen = prevOskOpenRef.current
    prevOskOpenRef.current = osk.isOskOpen
    if (!wasOpen && osk.isOskOpen && isMobileShell) {
      const ed = editorRef.current
      const el = ed?.view.dom ?? null
      if (el) {
        requestAnimationFrame(() => el.scrollIntoView({ block: 'center' }))
      }
    }
  }, [osk.isOskOpen, isMobileShell])

  // Story 4 (spec-in-chat-agent-switch): the in-chat agent control joins the
  // right chip cluster (CAP-1). Reads the store itself (session.switching,
  // current-agent resolution, resolved entries); only the busy/disabled
  // gates flow from the composer's props. The launcher places its agent
  // picker left-most in the equivalent cluster — mirror that placement.
  // Narrow-mode row 1 gates on a CHEAP session-derived boolean (the live
  // agent id OR the session-index agentConfigId), NOT the picker's presence
  // callback: `agentSwitchChip` renders inside row 1, so keying row 1 on a
  // value only the mounted picker can set true is circular — a
  // mode-less/model-less session would never mount it. The index fallback
  // covers the reopen window where openHistorySession installs the restored
  // session (agentConfigId present, runtime agentId not yet) — the picker
  // resolves the indexed config, so the toolbar must mount then too.
  const indexedAgentConfigId = useAcpStore(
    (s) => s.sessionIndex?.find((e) => e.id === session.id)?.agentConfigId
  )
  const agentControlMounted = Boolean(session.agentId) || Boolean(indexedAgentConfigId)
  const selectorMounted =
    agentControlMounted ||
    Boolean(modelOption) ||
    Boolean(thoughtLevel) ||
    Boolean(fastMode) ||
    modelConfig.length > 0 ||
    nonFastGenericOptions.length > 0 ||
    (sessionUsage != null && Number.isFinite(sessionUsage.size) && sessionUsage.size > 0)
  const modelSelector = selectorMounted ? (
    <AgentModelSelector
      sessionId={session.id}
      busy={busy}
      disabled={disabled}
      modelOption={modelOption}
      modelSource={modelSource}
      thoughtLevel={thoughtLevel}
      fastMode={fastMode}
      genericOptions={[...modelConfig, ...nonFastGenericOptions]}
      usage={sessionUsage}
      messages={messages}
      agentTemplateId={agentTemplateId}
      agentIcon={agentIcon}
      onSetConfig={onSetConfig}
      onSetModel={onSetModel}
    />
  ) : null

  // Mobile one-row toolbar: the mode label goes icon-only on a narrow pane.
  const agentModeChip = (
    <ModeChip
      session={session}
      disabled={disabled}
      onSelect={onSetMode}
      label="Agent"
      agentName={modeAgentName}
      className={isMobileShell ? 'shrink-0' : undefined}
      labelClassName={isMobileShell ? CHAT_COMPACT_LABEL : undefined}
    />
  )
  // One set of MCP props for the desktop badge popover and the mobile + sheet.
  const mcpListProps = {
    count: mcpCount,
    servers: mcpServers,
    onToggle: (id: string, enabled: boolean) => {
      void setMcpServerEnabled(id, enabled).catch(() => {
        toast.error('Could not update the MCP server. Your previous setting was restored.')
      })
    },
    probeStatus: mcpProbeStatus,
    probeError: mcpProbeError,
    tools: mcpTools,
    onLoadTools: (id: string) => {
      void loadMcpTools(id)
    }
  }
  const mcpBadge = <McpBadge {...mcpListProps} />
  const composerAddHandle = useMemo(
    () => ({
      canPick,
      pickFiles,
      insertTrigger: (trigger: '@' | '/') => insertComposerTrigger(editorRef.current, trigger),
      blurEditor: () => blurComposerEditor(editorRef.current)
    }),
    [canPick, pickFiles]
  )
  const sendButton = (
    <ComposerSendButton
      showStop={showStop}
      canSend={canSend}
      busy={busy}
      reduced={reduced}
      onCancel={onCancel}
      onSubmit={submit}
    />
  )
  return (
    <div
      ref={rootRef}
      className={cn(
        CHAT_GUTTER_X,
        compactTop ? 'pb-4 pt-0' : 'pb-6 pt-3',
        // The slash/mention menu overflows upward into the message list; lift
        // it above the list's jump-to-latest button (z-20).
        slashOpen || mentionMenuOpen ? 'relative z-30' : compactTop && 'relative z-10'
      )}
    >
      <div className="relative mx-auto w-full max-w-3xl">
        {disabled && (
          <div
            role="status"
            className="mb-2 rounded-lg border border-border/60 bg-secondary px-3 py-1.5 text-xs text-muted-foreground"
          >
            Session closed
          </div>
        )}
        {queue.length > 0 && onRemoveQueued && onSendQueuedNow && (
          <PromptQueuePanel
            items={queue}
            onRemove={onRemoveQueued}
            onSendNow={onSendQueuedNow}
            defaultOpen={!isMobileShell}
          />
        )}
        {slashOpen && (
          <SlashCommandMenu
            ref={slashMenuRef}
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
        <ComposerBeamShell busy={busy} reduced={reduced}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for attachments; the file picker button is the accessible path */}
          <div
            data-chat-composer="true"
            // Mobile: a programmatic focus target so focus returns here, not to
            // the editor (and the OSK), after an approval prompt resolves.
            tabIndex={isMobileShell ? -1 : undefined}
            className={cn(
              'relative rounded-2xl border border-border/60 bg-card transition-[border-color,box-shadow]',
              'focus-within:border-border focus-within:ring-1 focus-within:ring-inset focus-within:ring-foreground/20',
              dragActive && 'border-primary/70',
              isMobileShell && 'outline-none'
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
            {permission && <PermissionPrompt permission={permission} />}
            <AttachmentPreviewGroup attachments={attachments} onRemove={removeAttachment} />
            <div className="flex items-start gap-1 px-4 pb-1.5 pt-3.5">
              {/* Tiptap rich-text editor — the skill "pill" is a real inline
                  DOM node (a Tiptap `NodeView`), so the caret sits flush
                  against the pill's right edge by construction. No transparent
                  textarea + mirror overlay, no canvas padding, no overlay
                  scroll-sync. The `value` string (sentinel-token format) is
                  the shared model the wire builder + draft persistence +
                  timeline consume (byte-identical wire payload). */}
              <ChatComposerEditor
                className="min-w-0 flex-1"
                value={value}
                onValueChange={setValue}
                onCaretChange={mentions.update}
                onBeforeEditorKeyDown={handleKeyDown}
                onPasteAttachments={handlePaste}
                getSkillPaths={() => skillPathsRef.current}
                editorRef={editorRef}
                inputRef={composerInputRef}
                disabled={disabled || sending}
                minHeight={26} /* 1 line: 16px × 1.625 */
                maxHeight={78} /* 3 lines: 3 × 26px, then scroll */
                placeholder={
                  disabled
                    ? 'Composer unavailable'
                    : hasCommandToken
                      ? 'Add a message (optional)…'
                      : 'Ask anything… (/ for commands, @ for files)'
                }
              />
              {/* Context usage ring: top right, centered on the first line.
                  The mobile row carries the ring in its toolbar instead. */}
              {!isMobileShell && (
                <ContextUsageIndicator
                  usage={sessionUsage}
                  messages={messages}
                  className="-mr-2 -my-[3px]"
                />
              )}
            </div>
            <div
              className="flex items-center justify-between gap-3 px-2 pb-2"
              data-composer-toolbar={toolbarMode}
            >
              {isMobileShell ? (
                <div
                  className="flex min-w-0 flex-1 items-center gap-2"
                  data-composer-toolbar-row="mobile"
                >
                  <ComposerAddSheet
                    handle={composerAddHandle}
                    disabled={disabled}
                    {...mcpListProps}
                  />
                  {modelSelector}
                  {agentModeChip}
                  <div className="flex-1" />
                  <ContextUsageIndicator usage={sessionUsage} messages={messages} />
                  {sendButton}
                </div>
              ) : (
                <>
                  <div className="flex min-w-0 items-center gap-3">
                    {/* Disabled (not hidden) while the composer is inert — the
                    toolbar row stays put and the status banner explains why.
                    Same treatment as the launcher toolbar. */}
                    <AttachFilesButton onClick={() => void pickFiles()} disabled={!canPick} />
                    {mcpBadge}
                  </div>
                  <div
                    className={cn(
                      // #859: no wrap in narrow mode — the chip rows scroll
                      // horizontally instead of stacking to 3 lines.
                      'flex min-w-0 items-center justify-end gap-2.5',
                      toolbarMode === 'narrow' && 'flex-1'
                    )}
                  >
                    {(() => {
                      // Underlying availability conditions, not JSX-element
                      // truthiness — a chip element is always truthy even when it
                      // renders null internally (shared by both row layouts).
                      const agentModesAvailable =
                        session.modes != null && session.modes.availableModes.length > 0
                      return toolbarMode === 'narrow' ? (
                        (() => {
                          // The agent control gates row 1 on the session's live
                          // agent id (cheap, non-circular): the picker renders null
                          // itself when the agent resolves to nothing, so row 1
                          // never renders an empty container for it.
                          const hasRow1 = agentModesAvailable || selectorMounted
                          if (!hasRow1) return null
                          return (
                            <div className="flex min-w-0 flex-1 flex-col items-end gap-2">
                              {/* #859: rows scroll horizontally instead of wrapping
                              to 2–3 lines on phones (the composer grew to
                              ~220px when every picker wrapped). Chips keep
                              their own height; no wrap → one row each. */}
                              {hasRow1 && (
                                <div
                                  className="flex min-w-0 max-w-full items-center justify-end gap-2 overflow-x-auto scrollbar-hide"
                                  data-composer-toolbar-row="1"
                                >
                                  {modelSelector}
                                  {agentModeChip}
                                </div>
                              )}
                            </div>
                          )
                        })()
                      ) : agentModesAvailable || selectorMounted ? (
                        <div
                          className="flex min-w-0 flex-wrap items-center justify-end gap-2.5"
                          data-composer-toolbar-row="single"
                        >
                          {modelSelector}
                          {agentModeChip}
                        </div>
                      ) : null
                    })()}
                    {sendButton}
                  </div>
                </>
              )}
            </div>
          </div>
        </ComposerBeamShell>
        {!isMobileShell && (
          <div
            data-chat-composer-context-strip="true"
            className="relative z-0 mx-auto -mt-4 flex w-[calc(100%-2.75rem)] min-w-0 items-center gap-2 rounded-2xl border border-t-0 border-border/60 bg-card/60 px-2 pb-1 pt-5 text-xs text-muted-foreground"
          >
            <span
              className="inline-flex shrink-0 items-center gap-1.5 px-2.5"
              title={isolationModeTitle}
            >
              {isWorktree ? (
                <FolderGit2 size={13} className="shrink-0" aria-hidden="true" />
              ) : (
                <Folder size={13} className="shrink-0" aria-hidden="true" />
              )}
              <span className="sr-only">Workspace: </span>
              {isolationModeLabel}
            </span>
            {(isolationBranch || isDetachedHead) && (
              <span
                className="ml-auto inline-flex min-w-0 items-center justify-end gap-1.5 px-2.5"
                title={isolationBranch ?? 'HEAD is not on a branch'}
              >
                <GitBranch size={13} className="shrink-0" aria-hidden="true" />
                <span className="sr-only">Branch: </span>
                <span className="truncate">{isolationBranch ?? 'Detached HEAD'}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
