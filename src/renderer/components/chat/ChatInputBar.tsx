import type { Editor } from '@tiptap/core'
import { BorderBeam } from 'border-beam'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ArrowUp, Folder, FolderGit2, GitBranch, Paperclip, Square } from '@/components/icons'
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
import { persistenceApi } from '@/lib/api'
import { registerSessionTempFiles } from '@/lib/attachment-temp-cleanup'
import { cn } from '@/lib/utils'
import type { AcpSession, PendingPermission, QueuedPrompt } from '@/stores/acp-store'
import { useAcpMessages, useAcpStore, useAgentIdentity, useSessionUsage } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { AgentGlyph } from './AgentGlyph'
import { ConfigChip, ModeChip } from './AgentHeader'
import { AttachFilesButton } from './AttachFilesButton'
import { AttachmentPreviewGroup } from './AttachmentPreviewGroup'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { attachmentToBlock, dedupeAttachmentBlocks } from './chat-attachments'
import {
  extractFastModeOption,
  filterDuplicateModeConfigOptions,
  partitionConfigOptions,
  resolveModelOption
} from './chat-input-bar-config'
import { CHAT_GUTTER_X, useComposerToolbarMode } from './chat-layout'
import { iconPop } from './chat-motion'
import { ChatComposerEditor } from './composer/ChatComposerEditor'
import { FastModeToggle } from './FastModeToggle'
import { FileMentionMenu } from './FileMentionMenu'
import { McpBadge } from './McpBadge'
import { PermissionPrompt } from './PermissionPrompt'
import { PromptQueuePanel } from './PromptQueuePanel'
import { SlashCommandMenu, type SlashMenuHandle } from './SlashCommandMenu'
import { useChatComposer } from './use-chat-composer'
import { useComposerAttachments } from './use-composer-attachments'
import { useComposerCaretRestore, useComposerMentionSelect } from './use-composer-caret-restore'
import { useComposerMentions } from './use-composer-mentions'

// Subtle embossed/raised look shared by the send + stop buttons: soft outer
// drop shadow to lift the button off the composer, a top inner highlight, and a
// bottom inner shadow to fake a bevel. Fixed black/white tints read correctly
// on both the white-in-dark and black-in-light button shapes.
const EMBOSSED_BUTTON =
  'shadow-[0_1px_2px_oklch(0_0_0/0.28),inset_0_1px_0_oklch(1_0_0/0.16),inset_0_-1px_0_oklch(0_0_0/0.16)] hover:shadow-[0_2px_6px_oklch(0_0_0/0.34),inset_0_1px_0_oklch(1_0_0/0.22),inset_0_-1px_0_oklch(0_0_0/0.2)]'

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
  onSetConfig: (configId: string, valueId: string) => void | Promise<void>
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
  const usableConfigOptions = configOptions.filter((o) => o.options.length > 0)
  const hasConfigOptions = usableConfigOptions.length > 0
  // CAP-6: worktree/branch indicator. Worktree chats show their `chat/*`
  // branch (the long worktree path stays on the mode tooltip). Local chats fall
  // back to the project's reactive `gitBranch`. Switching chats re-renders via
  // `session`.
  const projectGitBranch = useProjectStore(
    (s) => s.projects.find((p) => p.id === session.projectId)?.gitBranch ?? null
  )
  const projectIsGitRepo = useProjectStore(
    (s) => s.projects.find((p) => p.id === session.projectId)?.isGitRepo ?? false
  )
  const isWorktree = Boolean(session.worktreePath)
  const isolationModeLabel = isWorktree ? 'Worktree' : 'Local'
  const isolationModeTitle = isWorktree
    ? `Agent works in a separate git worktree: ${session.worktreePath}`
    : 'Agent edits files in your project folder directly'
  const isolationBranch = session.worktreeBranch ?? projectGitBranch
  const isDetachedHead = !isolationBranch && !isWorktree && projectIsGitRepo
  const {
    model,
    thoughtLevel,
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
  const { templateId: agentTemplateId, icon: agentIcon } = useAgentIdentity(session.agentId)
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
  const [value, setValue] = useState('')
  // Persist the in-progress composer draft per session (project + session id)
  // so an unsent message survives a web reload. useState stays the source of
  // truth; the persisted copy is a recovery fallback only — hydrate on mount,
  // debounce writes on change, and clear (delete) when the composer empties
  // (covers both manual clear and clear-on-send). External seeding (editing a
  // message) takes precedence over a stale draft.
  const draftKey = `chat-draft/${session.projectId}/${session.id}`
  // Guard against undefined/null ids collapsing the key to
  // `chat-draft/undefined/undefined` and cross-session drafts colliding.
  const canPersistDraft = session.projectId != null && session.id != null
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (seedNonce !== undefined) {
      // Editing/seeding a message — don't restore a stale draft over the seed.
      hydratedRef.current = true
      return
    }
    if (!canPersistDraft) {
      // projectId/sessionId missing — can't key a draft; treat as hydrated so
      // the write effect's hydration gate doesn't block (it also guards).
      hydratedRef.current = true
      return
    }
    let cancelled = false
    hydratedRef.current = false
    void persistenceApi
      .read<string>(draftKey)
      .then((result) => {
        if (cancelled) return
        if (result.success && typeof result.data === 'string' && result.data) {
          setValue(result.data)
        }
      })
      .catch(() => {
        // Storage unavailable/corrupt — degrade to empty (no UI crash).
      })
      .finally(() => {
        if (!cancelled) hydratedRef.current = true
      })
    return () => {
      cancelled = true
    }
  }, [draftKey, seedNonce, canPersistDraft])

  // Debounced draft write on change — only after hydration so the just-loaded
  // draft isn't clobbered with '' before the read resolves. Empty value
  // clears the persisted draft so a reload after send/empty stays clean.
  // While editing/seeding a message (seedNonce set), skip persistence so the
  // seeded text isn't leaked back as the session's draft (reload would restore
  // the edited message into the composer).
  useEffect(() => {
    if (seedNonce !== undefined) return
    if (!canPersistDraft) return
    if (!hydratedRef.current) return
    if (!value) {
      void persistenceApi.delete(draftKey).catch(() => {})
      return
    }
    const handle = setTimeout(() => {
      void persistenceApi.writeDebounced(draftKey, value).catch(() => {})
    }, 400)
    return () => clearTimeout(handle)
  }, [value, draftKey, seedNonce, canPersistDraft])

  // Flush the latest draft on unmount only (AskUserQuestion replaces the
  // composer). Keep a ref so we do not defeat the debounce on every keystroke.
  const draftValueRef = useRef(value)
  draftValueRef.current = value
  useEffect(() => {
    return () => {
      if (seedNonce !== undefined) return
      if (!canPersistDraft) return
      const latest = draftValueRef.current
      if (!latest) return
      void persistenceApi.write(draftKey, latest).catch(() => {})
    }
  }, [draftKey, seedNonce, canPersistDraft])
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
  const iconMotion = iconPop(reduced)

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
    skillPathsRef
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

  const modelChip = modelOption ? (
    <ConfigChip
      key={modelOption.id}
      option={modelOption}
      disabled={disabled}
      searchable
      maxVisibleOptions={5}
      leading={
        <AgentGlyph
          templateId={agentTemplateId}
          icon={agentIcon}
          size={13}
          className="text-muted-foreground"
        />
      }
      onSelect={(valueId) =>
        modelSource === 'models' ? onSetModel(valueId) : onSetConfig(modelOption.id, valueId)
      }
    />
  ) : null

  const thoughtChip = thoughtLevel ? (
    <ConfigChip
      key={thoughtLevel.id}
      option={thoughtLevel}
      disabled={disabled}
      promoted
      onSelect={(valueId) => onSetConfig(thoughtLevel.id, valueId)}
    />
  ) : null

  const fastModeToggle = fastMode ? (
    <FastModeToggle
      key={fastMode.id}
      option={fastMode}
      disabled={disabled}
      onSelect={(valueId) => onSetConfig(fastMode.id, valueId)}
    />
  ) : null

  const genericChips =
    nonFastGenericOptions.length > 0
      ? nonFastGenericOptions.map((option) => (
          <ConfigChip
            key={option.id}
            option={option}
            disabled={disabled}
            onSelect={(valueId) => onSetConfig(option.id, valueId)}
          />
        ))
      : null

  const agentModeChip = (
    <ModeChip session={session} disabled={disabled} onSelect={onSetMode} label="Agent" />
  )

  const mcpBadge = (
    <McpBadge
      count={mcpCount}
      servers={mcpServers}
      onToggle={(id, enabled) => {
        void setMcpServerEnabled(id, enabled).catch(() => {
          toast.error('Could not update the MCP server. Your previous setting was restored.')
        })
      }}
      probeStatus={mcpProbeStatus}
      probeError={mcpProbeError}
      tools={mcpTools}
      onLoadTools={(id) => {
        void loadMcpTools(id)
      }}
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
            className="mb-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
          >
            Session closed
          </div>
        )}
        {queue.length > 0 && onRemoveQueued && onSendQueuedNow && (
          <PromptQueuePanel items={queue} onRemove={onRemoveQueued} onSendNow={onSendQueuedNow} />
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
            className={cn(
              'relative rounded-2xl border border-border/60 bg-card transition-[border-color,box-shadow]',
              'focus-within:border-border focus-within:ring-1 focus-within:ring-inset focus-within:ring-foreground/20',
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
            {permission && <PermissionPrompt permission={permission} />}
            <AttachmentPreviewGroup attachments={attachments} onRemove={removeAttachment} />
            <div className="px-4 pb-1.5 pt-3.5">
              {/* Tiptap rich-text editor — the skill "pill" is a real inline
                  DOM node (a Tiptap `NodeView`), so the caret sits flush
                  against the pill's right edge by construction. No transparent
                  textarea + mirror overlay, no canvas padding, no overlay
                  scroll-sync. The `value` string (sentinel-token format) is
                  the shared model the wire builder + draft persistence +
                  timeline consume (byte-identical wire payload). */}
              <ChatComposerEditor
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
            </div>
            <div
              className="flex items-center justify-between gap-3 px-2 pb-2"
              data-composer-toolbar={toolbarMode}
            >
              <div className="flex min-w-0 items-center gap-3">
                {canPick && <AttachFilesButton onClick={() => void pickFiles()} />}
                {mcpBadge}
              </div>
              <div
                className={cn(
                  'flex min-w-0 flex-wrap items-center justify-end gap-2.5',
                  toolbarMode === 'narrow' && 'flex-1'
                )}
              >
                {toolbarMode === 'narrow' ? (
                  (() => {
                    // Use the underlying availability conditions, not JSX-element
                    // truthiness — a chip element is always truthy even when it
                    // renders null internally, which made this empty-row guard
                    // unreachable in narrow mode.
                    const agentModesAvailable =
                      session.modes != null && session.modes.availableModes.length > 0
                    const hasRow1 = agentModesAvailable || Boolean(modelChip)
                    const hasRow2 = hasConfigOptions
                    if (!hasRow1 && !hasRow2) return null
                    return (
                      <div className="flex min-w-0 flex-1 flex-col items-end gap-2">
                        {hasRow1 && (
                          <div
                            className="flex min-w-0 flex-wrap items-center justify-end gap-2"
                            data-composer-toolbar-row="1"
                          >
                            {modelChip}
                            {agentModeChip}
                          </div>
                        )}
                        {hasRow2 && (
                          <div
                            className="flex min-w-0 flex-wrap items-center justify-end gap-2"
                            data-composer-toolbar-row="2"
                          >
                            {thoughtChip}
                            {fastModeToggle}
                            {genericChips}
                          </div>
                        )}
                      </div>
                    )
                  })()
                ) : (
                  <div
                    className="flex min-w-0 flex-wrap items-center justify-end gap-2.5"
                    data-composer-toolbar-row="single"
                  >
                    {modelChip}
                    {thoughtChip}
                    {fastModeToggle}
                    {genericChips}
                    {agentModeChip}
                  </div>
                )}
                <ContextUsageIndicator usage={sessionUsage} messages={messages} />
                <div className="relative size-8 shrink-0 overflow-visible">
                  <AnimatePresence initial={false} mode="popLayout">
                    {showStop ? (
                      <motion.button
                        key="stop"
                        type="button"
                        data-press-feedback="off"
                        onClick={onCancel}
                        title="Cancel turn"
                        aria-label="Cancel turn"
                        initial={iconMotion.initial}
                        animate={iconMotion.animate}
                        exit={iconMotion.exit}
                        transition={iconMotion.transition}
                        className={cn(
                          'absolute inset-0 flex items-center justify-center rounded-lg bg-foreground text-background transition-[scale,background-color,box-shadow] duration-200 ease-out hover:bg-foreground/90 active:scale-[0.96]',
                          "after:absolute after:-inset-1.5 after:content-[''] @[400px]:after:-inset-1",
                          EMBOSSED_BUTTON
                        )}
                      >
                        <Square size={10} fill="currentColor" strokeWidth={0} />
                      </motion.button>
                    ) : (
                      <motion.button
                        key="send"
                        type="button"
                        data-press-feedback="off"
                        onClick={() => void submit()}
                        disabled={!canSend}
                        title={busy ? 'Queue message' : 'Send'}
                        aria-label={busy ? 'Queue message' : 'Send message'}
                        initial={iconMotion.initial}
                        animate={iconMotion.animate}
                        exit={iconMotion.exit}
                        transition={iconMotion.transition}
                        className={cn(
                          'absolute inset-0 flex items-center justify-center rounded-lg transition-[scale,background-color,color,box-shadow] duration-200 ease-out',
                          "after:absolute after:-inset-1.5 after:content-[''] @[400px]:after:-inset-1",
                          canSend
                            ? cn(
                                'bg-foreground text-background hover:bg-foreground/90 active:scale-[0.96]',
                                EMBOSSED_BUTTON
                              )
                            : 'cursor-not-allowed bg-muted text-muted-foreground'
                        )}
                      >
                        <ArrowUp size={18} />
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </ComposerBeamShell>
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
      </div>
    </div>
  )
}

/**
 * BorderBeam only when motion is allowed. Under prefers-reduced-motion the beam
 * wrapper is omitted entirely (no keyframes / data-active), not merely paused.
 */
function ComposerBeamShell({
  busy,
  reduced,
  children
}: {
  busy: boolean
  reduced: boolean
  children: React.ReactNode
}): React.JSX.Element {
  if (reduced) {
    return <div className="relative z-10 w-full">{children}</div>
  }
  return (
    <BorderBeam
      size="md"
      colorVariant="mono"
      theme="auto"
      borderRadius={16}
      active={busy}
      className="relative z-10 w-full"
    >
      {children}
    </BorderBeam>
  )
}
