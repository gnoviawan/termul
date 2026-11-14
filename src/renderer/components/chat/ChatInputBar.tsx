import type { Editor } from '@tiptap/core'
import { useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { ClaudeAccountChip } from '@/components/chat/claude-account/ClaudeAccountChip'
import { ClaudeLimitWarning } from '@/components/chat/claude-account/ClaudeLimitWarning'
import { CodexAccountChip } from '@/components/chat/codex-account/CodexAccountChip'
import { CodexLimitWarning } from '@/components/chat/codex-account/CodexLimitWarning'
import { Paperclip } from '@/components/icons'
import { useAgentSkills } from '@/hooks/use-agent-skills'
import { useAttachmentDropZone } from '@/hooks/use-attachment-drop-zone'
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
import type { TermulToolId } from '@/lib/composer/termul-tools'
import { cn } from '@/lib/utils'
import type { AcpSession, PendingPermission, QueuedPrompt } from '@/stores/acp-store'
import {
  useAcpMessages,
  useAcpStore,
  useAgentIcon,
  useAgentTemplateId,
  useSessionUsage
} from '@/stores/acp-store'
import type { OptionValues } from '@/stores/acp-store/composer-options'
import { ModeChip } from './AgentHeader'
import { AttachmentPreviewGroup } from './AttachmentPreviewGroup'
import { AgentModelSelector } from './agent-model-selector/AgentModelSelector'
import { useCurrentAgentConfigId } from './agent-model-selector/use-agent-switch'
import { ChatContextStrip } from './ChatContextStrip'
import { ComposerBeamShell } from './ComposerBeamShell'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { appOwnedTempPaths } from './chat-attachments'
import {
  extractFastModeOption,
  filterDuplicateModeConfigOptions,
  partitionConfigOptions,
  resolveModelOption
} from './chat-input-bar-config'
import { CHAT_GUTTER_X, COMPOSER_CARD_CLASS, useComposerToolbarMode } from './chat-layout'
import { ChatComposerEditor, focusComposerFromRowPress } from './composer/ChatComposerEditor'
import { ComposerAddMenu } from './composer/ComposerAddMenu'
import { ComposerAddSheet } from './composer/ComposerAddSheet'
import { ComposerSendButton } from './composer/ComposerSendButton'
import { blurComposerEditor, insertComposerTrigger } from './composer/insert-composer-trigger'
import { insertComposerTool } from './composer/insert-pill'
import {
  type SelectionContextInsertRequest,
  useSelectionContextInsertRequest
} from './composer/insert-selection-context'
import { useChatConnectors } from './composer/use-chat-connectors'
import { useTermulTools } from './composer/use-termul-tools'
import { buildComposerSend } from './composer-send-blocks'
import { FileMentionMenu } from './FileMentionMenu'
import { PermissionPrompt } from './PermissionPrompt'
import { PromptQueuePanel } from './PromptQueuePanel'
import { SlashCommandMenu, type SlashMenuHandle } from './SlashCommandMenu'
import { SkillFilesProvider } from './skill-file-links'
import { useChatComposer } from './use-chat-composer'
import { useComposerAttachments } from './use-composer-attachments'
import { useComposerCaretRestore, useComposerMentionSelect } from './use-composer-caret-restore'
import { useComposerDraft } from './use-composer-draft'
import { useComposerDraftStart } from './use-composer-draft-start'
import { useComposerMentions } from './use-composer-mentions'
import { useComposerSendLock } from './use-composer-send-lock'

interface ChatInputBarProps {
  /** Active session — drives selector chips. */
  session: AcpSession
  /** Project/worktree root used to discover project-local skills. */
  projectRoot?: string
  /** Whether a prompt turn is currently active (disables send, enables cancel). */
  busy: boolean
  /** Whether the session is closed/disconnected (fully disables input). */
  disabled: boolean
  /**
   * Whether the agent-backed controls (model / mode / config pickers, agent
   * switch, slash-menu config and mode rows) are disabled. Defaults to
   * `disabled`. A stopped chat that resumes on input keeps the editor enabled
   * but these controls off: they would hit the stopped agent.
   */
  controlsDisabled?: boolean
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
  /**
   * Apply a model pick, then its option values (`values`: a favorite's
   * snapshot). May return a Promise for chip pending UI.
   */
  onSetModel: (modelId: string, values?: OptionValues) => void | Promise<void>
  /** External text to load into the composer (edit a message / pick a suggestion). */
  seedText?: string
  /** Bump to re-apply `seedText` even if the text is unchanged. */
  seedNonce?: number
  /** Add a selection context chip at the composer caret (from the message list). */
  selectionContextInsert?: SelectionContextInsertRequest
  /** Pending prompts shown above the composer. */
  queue?: QueuedPrompt[]
  /** Approval request currently waiting for the user. */
  permission?: PendingPermission | null
  onRemoveQueued?: (queueId: string) => void
  onSendQueuedNow?: (queueId: string) => void
  /**
   * Whether the host chat panel's tab is the pane's active tab. While false,
   * the per-flush `useAcpMessages` re-render is frozen (same render gate as
   * AgentChatPanel): the subscription stays live, but the derived value holds
   * its last-visible snapshot so a hidden panel's composer does no per-flush
   * work. Defaults to true (visible) for other hosts.
   */
  isVisible?: boolean
  /**
   * Fired when the user starts a draft: the first edit or paste into an empty
   * composer (no text, no attachments). A restored draft or a seed never
   * fires it. The chat panel uses it to resume a stopped chat early.
   */
  onDraftStart?: () => void
}

const NO_CONFIG_OPTIONS: SessionConfigOption[] = []

export function ChatInputBar({
  session,
  projectRoot,
  busy,
  disabled,
  controlsDisabled = disabled,
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
  selectionContextInsert,
  queue = [],
  permission,
  onRemoveQueued,
  onSendQueuedNow,
  isVisible = true,
  onDraftStart
}: ChatInputBarProps): React.JSX.Element {
  const usableConfigOptions = configOptions.filter(
    (option) => option.type === 'boolean' || (option.options?.length ?? 0) > 0
  )
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
  // Compact shows only when the agent lists `/compact`; it sends the command as a prompt.
  const hasCompactCommand = commands.some((command) => command.name === 'compact')
  const onCompact = useMemo(
    () => (hasCompactCommand ? () => onSend('/compact') : undefined),
    [hasCompactCommand, onSend]
  )
  const compactSignals = useMemo(
    () => ({
      connected: session.status === 'active',
      activeTurn: session.activeTurn,
      compaction: session.opencodeNotice?.compaction ?? null
    }),
    [session.status, session.activeTurn, session.opencodeNotice?.compaction]
  )
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
  // A launch placeholder has no agent yet, so resolve by config id: the armed
  // target, else the chat's own config (the launching one before spawn).
  const glyphConfigId = armedConfigId ?? currentAgentConfigId ?? undefined
  const agentTemplateId = useAgentTemplateId(session.agentId, glyphConfigId)
  const agentIcon = useAgentIcon(session.agentId, glyphConfigId)
  const { connectors, host: connectorsHost } = useChatConnectors(session)
  const termulTools = useTermulTools(session.projectId)
  const [value, setValue] = useComposerDraft({
    projectId: session.projectId,
    sessionId: session.id,
    seedNonce
  })
  const { locked: sending, hold: holdComposer } = useComposerSendLock()
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
    canPick,
    canPickImages,
    canDropPaste
  } = useComposerAttachments({ imageCapable, embedCapable, disabled: disabled || sending })
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
    projectId: session.projectId,
    currentSessionId: session.id,
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
  const mentionMenuRef = mentions.menuRef
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
    buildPromptParts,
    conversationContexts
  } = useChatComposer({
    value,
    setValue,
    editorRef,
    slashMenuRef,
    commands,
    // Slash-menu config / mode rows set options on the live agent — hidden
    // while the agent-backed controls are off.
    configOptions: controlsDisabled ? NO_CONFIG_OPTIONS : configOptions,
    modes: controlsDisabled ? null : modes,
    skills: availableSkills,
    disabled,
    onSetConfig,
    onSetMode,
    onSetModel,
    mentions,
    scheduleRestoreCaret
  })
  const slashOpen = composerSlashOpen && !sending
  const mentionMenuOpen = mentions.menuOpen && !disabled && !sending && !slashOpen

  const { handleValueChange, handleComposerPaste } = useComposerDraftStart({
    draftEmpty: value.length === 0 && attachments.length === 0,
    onDraftStart,
    setValue,
    handlePaste
  })

  const canSend = !disabled && !sending && (value.trim().length > 0 || attachments.length > 0)
  const showStop = busy && !canSend

  const submit = useCallback(async () => {
    const hasAttachments = attachments.length > 0
    const hasText = value.trim().length > 0
    if ((!hasText && !hasAttachments) || disabled || sending) return

    await holdComposer(async () => {
      const contexts = conversationContexts()
      const send = buildComposerSend(
        buildPromptParts(contexts ? await contexts : undefined),
        attachments
      )
      if (!send) return
      if (send.kind === 'text') onSend(send.text)
      else if (send.display) onSendBlocks(send.wire, send.display)
      else onSendBlocks(send.wire)
      // Register app-owned temp files (pasted screenshots) with the session so
      // they are deleted when the session closes; clearAttachments drops state
      // without deleting because the agent reads them by path during the turn.
      registerSessionTempFiles(session.id, appOwnedTempPaths(attachments))
      // A remap to another chat mid-await hydrates that chat's draft; keep it.
      setValue((current) => (current === value ? '' : current))
      skillPathsRef.current = {}
      clearAttachments(attachments)
      resetMentions()
    }).catch((err: unknown) => {
      // Skill path resolution throws a specific user-facing message — keep it.
      const msg = err instanceof Error ? err.message : ''
      toast.error(msg.includes('missing a path') ? msg : 'Could not send your message. Try again.')
    })
  }, [
    value,
    attachments,
    disabled,
    sending,
    clearAttachments,
    onSend,
    onSendBlocks,
    resetMentions,
    session.id,
    buildPromptParts,
    conversationContexts,
    skillPathsRef,
    setValue,
    holdComposer
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
  useSelectionContextInsertRequest(editorRef, selectionContextInsert, disabled)

  // Story 5.3 (T2.3): on mobile web, scroll the editor into view once per
  // OSK-open window so iOS Safari doesn't leave the input under the keyboard.
  // rAF-deferred to let layout settle; fires once per OSK-open window.
  // `nearest` scrolls only as far as needed to show the editor (iOS) and not
  // at all when it already shows above the keyboard (Android resizes the
  // layout onto it); `center` slid the composer up and left it there.
  useEffect(() => {
    const wasOpen = prevOskOpenRef.current
    prevOskOpenRef.current = osk.isOskOpen
    if (!wasOpen && osk.isOskOpen && isMobileShell) {
      const ed = editorRef.current
      const el = ed?.view.dom ?? null
      if (el) {
        requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }))
      }
    }
  }, [osk.isOskOpen, isMobileShell])

  // Story 4 (spec-in-chat-agent-switch): the in-chat agent control joins the
  // right chip cluster (CAP-1). Reads the store itself (session.switching,
  // current-agent resolution, resolved entries); only the busy/disabled
  // gates flow from the composer's props. The launcher places its agent
  // picker left-most in the equivalent cluster — mirror that placement.
  // Narrow-mode row 1 gates on a CHEAP session-derived boolean (the live
  // agent id OR the chat's config id), NOT the picker's presence callback:
  // `agentSwitchChip` renders inside row 1, so keying row 1 on a value only
  // the mounted picker can set true is circular — a mode-less/model-less
  // session would never mount it. The config id covers a launch placeholder
  // before its agent spawns and the reopen window where openHistorySession
  // installs the restored session before its agent reconnects.
  const agentControlMounted = Boolean(session.agentId) || Boolean(currentAgentConfigId)
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
      disabled={controlsDisabled}
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
      phone={
        isMobileShell
          ? {
              modes: session.modes,
              onSetMode,
              compact: { onCompact, signals: compactSignals }
            }
          : undefined
      }
    />
  ) : null

  const agentModeChip = (
    <ModeChip
      session={session}
      disabled={controlsDisabled}
      onSelect={onSetMode}
      label="Agent"
      agentName={modeAgentName}
    />
  )
  const composerAddHandle = useMemo(
    () => ({
      canPick,
      canPickImages,
      pickFiles,
      insertTrigger: (trigger: '@' | '/') => insertComposerTrigger(editorRef.current, trigger),
      blurEditor: () => blurComposerEditor(editorRef.current),
      focusEditor: () => editorRef.current?.commands.focus(undefined, { scrollIntoView: false }),
      insertTool: (id: TermulToolId) => insertComposerTool(editorRef.current, id)
    }),
    [canPick, canPickImages, pickFiles]
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
        'pb-6 pt-3',
        // The slash/mention menu overflows upward into the message list; lift
        // it above the list's jump-to-latest button (z-20).
        (slashOpen || mentionMenuOpen) && 'relative z-30'
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
            menu={mentions.view}
            onSelect={onMentionSelect}
            onBack={mentions.back}
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
              'relative',
              COMPOSER_CARD_CLASS,
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
            {permission && <PermissionPrompt permission={permission} isVisible={isVisible} />}
            {!controlsDisabled && <ClaudeLimitWarning sessionId={session.id} atTop={!permission} />}
            {!controlsDisabled && <CodexLimitWarning sessionId={session.id} atTop={!permission} />}
            <AttachmentPreviewGroup
              attachments={attachments}
              onRemove={removeAttachment}
              removeDisabled={disabled || sending}
            />
            {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only focus aid for the padding; the editor is the accessible target */}
            <div
              data-composer-row
              className="flex items-start gap-1 px-4 pb-1.5 pt-3.5"
              onMouseDown={(event) => focusComposerFromRowPress(event, editorRef.current)}
            >
              {/* Tiptap rich-text editor — the skill "pill" is a real inline
                  DOM node (a Tiptap `NodeView`), so the caret sits flush
                  against the pill's right edge by construction. No transparent
                  textarea + mirror overlay, no canvas padding, no overlay
                  scroll-sync. The `value` string (sentinel-token format) is
                  the shared model the wire builder + draft persistence +
                  timeline consume (byte-identical wire payload). */}
              <SkillFilesProvider projectRoot={projectRoot ?? session.cwd}>
                <ChatComposerEditor
                  className="min-w-0 flex-1"
                  value={value}
                  onValueChange={handleValueChange}
                  onCaretChange={mentions.update}
                  onBeforeEditorKeyDown={handleKeyDown}
                  onPasteAttachments={handleComposerPaste}
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
                        : 'Ask anything… (/ for commands, @ for files and chats)'
                  }
                />
              </SkillFilesProvider>
              {/* Context usage ring: top right, centered on the first line.
                  The mobile row carries the ring in its toolbar instead. */}
              {!isMobileShell && (
                <ContextUsageIndicator
                  usage={sessionUsage}
                  messages={messages}
                  className="-mr-2 -my-[3px]"
                  onCompact={onCompact}
                  compactSignals={compactSignals}
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
                    disabled={disabled || sending}
                    termulTools={termulTools}
                    connectorsHost={connectorsHost}
                    {...connectors}
                  />
                  {modelSelector}
                  <div className="flex-1" />
                  <ContextUsageIndicator
                    usage={sessionUsage}
                    messages={messages}
                    onCompact={onCompact}
                    compactSignals={compactSignals}
                  />
                  {sendButton}
                </div>
              ) : (
                <>
                  <div className="flex min-w-0 items-center gap-3">
                    {/* While the composer is inert its rows are disabled, not
                    hidden; connectors stay usable. Same as the launcher. */}
                    <ComposerAddMenu
                      handle={composerAddHandle}
                      disabled={disabled || sending}
                      connectors={connectors}
                      connectorsHost={connectorsHost}
                      termulTools={termulTools}
                    />
                    <ClaudeAccountChip sessionId={session.id} />
                    <CodexAccountChip sessionId={session.id} />
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
        {!isMobileShell && <ChatContextStrip session={session} />}
      </div>
    </div>
  )
}
