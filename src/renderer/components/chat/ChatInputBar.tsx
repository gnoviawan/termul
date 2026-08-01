import { BorderBeam } from 'border-beam'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowUp, Paperclip, Square } from 'lucide-react'
import {
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useMentionRecents } from '@/hooks/use-mention-recents'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useOskViewport } from '@/hooks/use-osk-viewport'
import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
  SessionModeState
} from '@/lib/acp-api'
import { registerSessionTempFiles } from '@/lib/attachment-temp-cleanup'
import { cn } from '@/lib/utils'
import type { AcpSession, QueuedPrompt } from '@/stores/acp-store'
import { useAcpMessages, useAcpStore, useSessionUsage } from '@/stores/acp-store'
import { ConfigChip, ModeChip } from './AgentHeader'
import { AttachFilesButton } from './AttachFilesButton'
import { AttachmentPreviewGroup } from './AttachmentPreviewGroup'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { attachmentToBlock, dedupeAttachmentBlocks } from './chat-attachments'
import {
  filterDuplicateModeConfigOptions,
  partitionConfigOptions,
  resolveModelOption
} from './chat-input-bar-config'
import { CHAT_GUTTER_X, useComposerToolbarMode } from './chat-layout'
import { iconPop } from './chat-motion'
import { FileMentionMenu } from './FileMentionMenu'
import { McpBadge } from './McpBadge'
import { PromptQueuePanel } from './PromptQueuePanel'
import { SlashCommandMenu, type SlashMenuHandle } from './SlashCommandMenu'
import { tryHandleSlashMenuKeyDown } from './slash-menu-keyboard'
import {
  applyCommandToInput,
  buildSlashSections,
  isSlashTrigger,
  type SlashItem,
  slashFilter
} from './slash-menu-model'
import { dataTransferFiles, useComposerAttachments } from './use-composer-attachments'
import { useComposerMentions } from './use-composer-mentions'
import { useComposerTextarea } from './use-composer-textarea'

// Subtle embossed/raised look shared by the send + stop buttons: soft outer
// drop shadow to lift the button off the composer, a top inner highlight, and a
// bottom inner shadow to fake a bevel. Fixed black/white tints read correctly
// on both the white-in-dark and black-in-light button shapes.
const EMBOSSED_BUTTON =
  'shadow-[0_1px_2px_hsl(0_0%_0%/0.28),inset_0_1px_0_hsl(0_0%_100%/0.16),inset_0_-1px_0_hsl(0_0%_0%/0.16)] transition-shadow hover:shadow-[0_2px_6px_hsl(0_0%_0%/0.34),inset_0_1px_0_hsl(0_0%_100%/0.22),inset_0_-1px_0_hsl(0_0%_0%/0.2)]'

interface ChatInputBarProps {
  /** Active session — drives selector chips. */
  session: AcpSession
  /** Whether a prompt turn is currently active (disables send, enables cancel). */
  busy: boolean
  /** Whether the session is closed/disconnected (fully disables input). */
  disabled: boolean
  /** Whether the agent accepts inline image content blocks (drag/paste images). */
  imageCapable?: boolean
  /** Whether the agent accepts embedded `resource` blocks (drag/paste text files). */
  embedCapable?: boolean
  onSend: (text: string) => void
  /** Send a prompt carrying structured content blocks (text + attachments). */
  onSendBlocks: (blocks: ContentBlock[]) => void
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
  onRemoveQueued?: (queueId: string) => void
  onSendQueuedNow?: (queueId: string) => void
}

export function ChatInputBar({
  session,
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
  onRemoveQueued,
  onSendQueuedNow
}: ChatInputBarProps): React.JSX.Element {
  const usableConfigOptions = configOptions.filter((o) => o.options.length > 0)
  const hasConfigOptions = usableConfigOptions.length > 0
  const {
    model,
    thoughtLevel,
    rest: genericConfigOptions
  } = partitionConfigOptions(usableConfigOptions)
  const { option: modelOption, source: modelSource } = resolveModelOption(model, session.models)
  const visibleGenericConfigOptions = filterDuplicateModeConfigOptions(genericConfigOptions, modes)
  const sessionUsage = useSessionUsage(session.id)
  const messages = useAcpMessages(session.id)
  // Prefer project/session-scoped MCP context. Older/local sessions without a
  // recorded count retain the existing global-registry fallback.
  const globalMcpCount = useAcpStore((s) => s.mcpServers.length)
  const mcpCount = session.mcpServerCount ?? globalMcpCount
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
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
    addFileRef,
    handlePaste,
    removeAttachment,
    clearAttachments,
    appOwnedTempPaths,
    canPick,
    canDropPaste
  } = useComposerAttachments({ imageCapable, embedCapable, disabled })
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarMode = useComposerToolbarMode(rootRef)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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
      addFileRef(m)
      pushMentionRecent(m)
    }
  })

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      dragDepth.current = 0
      setDragActive(false)
      if (!canDropPaste) return
      const files = dataTransferFiles(e.dataTransfer)
      if (files.length === 0) return
      e.preventDefault()
      void addFiles(files)
    },
    [canDropPaste, addFiles]
  )

  const handleDragEnter = useCallback(() => {
    if (!canDropPaste) return
    dragDepth.current += 1
    setDragActive(true)
  }, [canDropPaste])

  const handleDragLeave = useCallback(() => {
    if (!canDropPaste) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }, [canDropPaste])

  const slashOpen = isSlashTrigger(value) && !disabled
  const filter = slashFilter(value)
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
  } = useComposerTextarea({ value, setValue, textareaRef, mentions, disabled, slashOpen })

  const sections = useMemo(
    () => (slashOpen ? buildSlashSections({ commands, configOptions, modes, filter }) : []),
    [slashOpen, commands, configOptions, modes, filter]
  )

  const canSend = !disabled && !sending && (value.trim().length > 0 || attachments.length > 0)
  const showStop = busy && !canSend
  const iconMotion = iconPop(reduced)

  const submit = useCallback(async () => {
    const userText = value.trim()
    const hasAttachments = attachments.length > 0
    if ((!userText && !hasAttachments) || disabled || sending) return

    setSending(true)
    try {
      const text = userText
      const trimmed = text.trim()
      if (!trimmed && !hasAttachments) return

      if (hasAttachments) {
        const blocks: ContentBlock[] = []
        if (trimmed) blocks.push({ type: 'text', text })
        for (const a of attachments) blocks.push(attachmentToBlock(a))
        onSendBlocks(dedupeAttachmentBlocks(blocks))
      } else {
        onSend(text)
      }
      // Register app-owned temp files (pasted screenshots) with the session so
      // they are deleted when the session closes; clearAttachments drops state
      // without deleting because the agent reads them by path during the turn.
      registerSessionTempFiles(session.id, appOwnedTempPaths())
      setValue('')
      clearAttachments()
      resetMentions()
      resetHeight()
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
    resetHeight,
    resetMentions,
    session.id
  ])

  const handleSelect = useCallback(
    (item: SlashItem) => {
      if (item.kind === 'command') {
        const next = applyCommandToInput(value, item.name)
        setValue(next)
        updateMentions(next, next.length)
        textareaRef.current?.focus()
        return
      }
      if (item.kind === 'config') {
        // AgentChatPanel's setters toast then rethrow; swallow here so the
        // already-surfaced failure doesn't become an unhandled rejection.
        void Promise.resolve(onSetConfig(item.configId, item.valueId)).catch(() => {})
      } else {
        void Promise.resolve(onSetMode(item.modeId)).catch(() => {})
      }
      setValue('')
      updateMentions('', 0)
      resetHeight()
    },
    [value, onSetConfig, onSetMode, resetHeight, updateMentions]
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        tryHandleSlashMenuKeyDown(e, {
          menuOpen: slashOpen,
          sectionsLength: sections.length,
          menuRef: slashMenuRef,
          onClearInput: () => {
            setValue('')
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

      if (e.key === 'Escape' && busy) {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        if (showStop) return
        void submit()
      }
    },
    [
      slashOpen,
      sections.length,
      handleMentionKeyDown,
      updateMentions,
      busy,
      showStop,
      onCancel,
      submit,
      resetHeight
    ]
  )

  // Load externally-seeded text (edit a message, pick a starter prompt), then
  // focus and place the cursor at the end. Keyed on a nonce so re-picking the
  // same text still applies.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the intended trigger
  useEffect(() => {
    if (seedNonce === undefined) return
    const next = seedText ?? ''
    setValue(next)
    updateMentions(next, next.length)
    const el = textareaRef.current
    if (!el) return
    el.focus()
    requestAnimationFrame(() => {
      clampHeight(el)
      el.setSelectionRange(next.length, next.length)
    })
  }, [seedNonce, updateMentions, clampHeight])

  // Story 5.3 (T2.3): on mobile web, scroll the textarea into view once per
  // OSK-open window so iOS Safari doesn't leave the input under the keyboard.
  // Moved from onFocus (where `osk.isOskOpen` may still be false at focus
  // time) to a closed→open transition effect — mirrors AgentChatPanel. rAF-
  // deferred to let layout settle; fires once per OSK-open window.
  useEffect(() => {
    const wasOpen = prevOskOpenRef.current
    prevOskOpenRef.current = osk.isOskOpen
    if (!wasOpen && osk.isOskOpen && isMobileShell) {
      const el = textareaRef.current
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

  const genericChips = hasConfigOptions
    ? visibleGenericConfigOptions.map((option) => (
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

  const mcpBadge = <McpBadge count={mcpCount} />

  return (
    <div ref={rootRef} className={cn(CHAT_GUTTER_X, 'pb-2 pt-3')}>
      <div className="relative mx-auto w-full max-w-3xl">
        {queue.length > 0 && onRemoveQueued && onSendQueuedNow && (
          <PromptQueuePanel items={queue} onRemove={onRemoveQueued} onSendNow={onSendQueuedNow} />
        )}
        {slashOpen && (
          <SlashCommandMenu
            ref={slashMenuRef}
            sections={sections}
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
        <BorderBeam
          size="md"
          colorVariant="colorful"
          theme="dark"
          borderRadius={16}
          active={busy}
          className="w-full"
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for attachments; the file picker button is the accessible path */}
          <div
            className={cn(
              'relative rounded-2xl border border-border/60 bg-card transition-colors focus-within:border-border',
              dragActive && 'border-primary/70'
            )}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={canDropPaste ? (e) => e.preventDefault() : undefined}
            onDrop={handleDrop}
          >
            {dragActive && canDropPaste && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/80 text-sm font-medium text-foreground backdrop-blur-sm">
                <span className="flex items-center gap-2">
                  <Paperclip size={16} /> Drop files to attach
                </span>
              </div>
            )}
            <AttachmentPreviewGroup attachments={attachments} onRemove={removeAttachment} />
            <div className="px-4 pb-1.5 pt-3.5">
              <textarea
                ref={textareaRef}
                value={value}
                onChange={onInput}
                onKeyDown={handleKeyDown}
                onKeyUp={onKeyUp}
                onSelect={onSelect}
                onPaste={handlePaste}
                // Story 5.3 (T2.3): on mobile web when the OSK is open, scroll
                // the textarea into view once per OSK-open window so iOS Safari
                // doesn't leave the input under the keyboard. rAF-deferred to
                // let layout settle. Guarded against focus-loop thrash (the OSK
                // can re-focus the textarea as it animates; only the first
                // focus per OSK-open window triggers the scroll).
                onFocus={() => {
                  setFocused(true)
                  // OSK-open scroll is handled by the `osk.isOskOpen`
                  // transition effect above (the OSK state can lag the focus
                  // event, so reading it here was unreliable).
                }}
                onBlur={() => setFocused(false)}
                // Story 5.3 (T2.4): mobile keyboards show a "send" affordance.
                // Do NOT change Enter keyboard semantics — handleKeyDown still
                // routes Enter→send only when the slash menu is closed.
                inputMode="text"
                enterKeyHint="send"
                disabled={disabled || sending}
                rows={1}
                placeholder={
                  disabled ? 'Session closed' : 'Ask anything… (/ for commands, @ for files)'
                }
                className={cn(
                  'min-h-[52px] w-full resize-none bg-transparent text-sm leading-relaxed',
                  'placeholder:text-muted-foreground focus:outline-none',
                  'disabled:cursor-not-allowed disabled:opacity-50 max-h-40'
                )}
              />
            </div>
            <div
              className="flex items-center justify-between gap-3 px-2.5 pb-2.5"
              data-composer-toolbar={toolbarMode}
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
                  const hasRow2 = hasConfigOptions || mcpCount > 0
                  if (!hasRow1 && !hasRow2) return null
                  return (
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      {hasRow1 && (
                        <div
                          className="flex min-w-0 flex-wrap items-center gap-2"
                          data-composer-toolbar-row="1"
                        >
                          {agentModeChip}
                          {modelChip}
                        </div>
                      )}
                      {hasRow2 && (
                        <div
                          className="flex min-w-0 flex-wrap items-center gap-2"
                          data-composer-toolbar-row="2"
                        >
                          {thoughtChip}
                          {genericChips}
                          {mcpBadge}
                        </div>
                      )}
                    </div>
                  )
                })()
              ) : (
                <div
                  className="flex min-w-0 flex-wrap items-center gap-2"
                  data-composer-toolbar-row="single"
                >
                  {modelChip}
                  {thoughtChip}
                  {genericChips}
                  {agentModeChip}
                  {mcpBadge}
                </div>
              )}
              <div
                className={cn(
                  'flex shrink-0 items-center gap-2',
                  toolbarMode === 'narrow' && 'self-end'
                )}
              >
                <ContextUsageIndicator usage={sessionUsage} messages={messages} />
                {canPick && <AttachFilesButton onClick={() => void pickFiles()} />}
                <div className="relative size-[34px] shrink-0 overflow-visible">
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
                        exit={iconMotion.initial}
                        transition={iconMotion.transition}
                        className={cn(
                          'absolute inset-0 flex items-center justify-center rounded-lg bg-foreground text-background transition-transform hover:bg-foreground/90 active:scale-[0.96]',
                          EMBOSSED_BUTTON
                        )}
                      >
                        <Square size={12} fill="currentColor" strokeWidth={0} />
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
                        exit={iconMotion.initial}
                        transition={iconMotion.transition}
                        className={cn(
                          'absolute inset-0 flex items-center justify-center rounded-lg transition-transform',
                          canSend
                            ? cn(
                                'bg-foreground text-background hover:bg-foreground/90 active:scale-[0.96]',
                                EMBOSSED_BUTTON
                              )
                            : 'cursor-not-allowed bg-muted text-muted-foreground'
                        )}
                      >
                        <ArrowUp size={16} strokeWidth={2.5} />
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>
        </BorderBeam>
        <div
          className={cn(
            'flex items-center px-1 pt-1.5 text-3xs text-muted-foreground transition-opacity duration-150',
            focused ? 'opacity-100' : 'opacity-0'
          )}
        >
          {showStop ? (
            <>
              <KbdHint k="Esc" /> to stop
            </>
          ) : (
            <>
              <KbdHint k="Enter" /> {busy ? 'to queue' : 'to send'}
              <span className="mx-1.5 text-border">·</span>
              <KbdHint k="Shift+Enter" /> newline
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Inline keyboard-key hint used in the composer footer. */
function KbdHint({ k }: { k: string }): React.JSX.Element {
  return <kbd className="mr-1 font-mono text-[0.6rem] font-medium text-foreground">{k}</kbd>
}
