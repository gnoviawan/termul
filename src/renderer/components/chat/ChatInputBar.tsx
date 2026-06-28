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
import { toast } from 'sonner'
import {
  buildPromptWithLoadedSkill,
  type LoadedAgentSkill,
  useAgentSkills
} from '@/hooks/use-agent-skills'
import { useMentionRecents } from '@/hooks/use-mention-recents'
import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
  SessionModeState
} from '@/lib/acp-api'
import { registerSessionTempFiles } from '@/lib/attachment-temp-cleanup'
import { cn } from '@/lib/utils'
import type { AcpSession } from '@/stores/acp-store'
import { ConfigChip, ModeChip } from './AgentHeader'
import { AttachmentPreviewGroup } from './AttachmentPreviewGroup'
import { attachmentToBlock, dedupeAttachmentBlocks } from './chat-attachments'
import {
  filterDuplicateModeConfigOptions,
  partitionConfigOptions,
  resolveModelOption
} from './chat-input-bar-config'
import { CHAT_SPRING } from './chat-motion'
import { FileMentionMenu } from './FileMentionMenu'
import { LoadedSkillChip } from './LoadedSkillChip'
import { SlashCommandMenu, type SlashMenuHandle } from './SlashCommandMenu'
import { tryHandleSlashMenuKeyDown } from './slash-menu-keyboard'
import {
  applyCommandToInput,
  buildSlashSections,
  isSlashTrigger,
  type SlashItem,
  slashFilter
} from './slash-menu-model'
import { useComposerAttachments } from './use-composer-attachments'
import { useComposerMentions } from './use-composer-mentions'
import { useComposerTextarea } from './use-composer-textarea'

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
  /** Send a prompt carrying structured content blocks (text + attachments). */
  onSendBlocks: (blocks: ContentBlock[]) => void
  onCancel: () => void
  /** Slash-menu data sources from the active session. */
  commands: AvailableCommand[]
  configOptions: SessionConfigOption[]
  modes: SessionModeState | null
  /** Apply a config option value immediately. */
  onSetConfig: (configId: string, valueId: string) => void
  /** Apply a legacy mode immediately. */
  onSetMode: (modeId: string) => void
  /** Apply a native ACP model selection immediately. */
  onSetModel: (modelId: string) => void
  /** External text to load into the composer (edit a message / pick a suggestion). */
  seedText?: string
  /** Bump to re-apply `seedText` even if the text is unchanged. */
  seedNonce?: number
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
  seedNonce
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
  const { skills } = useAgentSkills(projectRoot ?? session.cwd)
  const [value, setValue] = useState('')
  const [loadedSkill, setLoadedSkill] = useState<LoadedAgentSkill | null>(null)
  const [sending, setSending] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const reduced = useReducedMotion() ?? false
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
      if (!canDropPaste || e.dataTransfer.files.length === 0) return
      e.preventDefault()
      void addFiles(e.dataTransfer.files)
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
    () => (slashOpen ? buildSlashSections({ commands, configOptions, modes, skills, filter }) : []),
    [slashOpen, commands, configOptions, modes, skills, filter]
  )

  const submit = useCallback(async () => {
    const userText = value.trim()
    const hasAttachments = attachments.length > 0
    if ((!userText && !loadedSkill && !hasAttachments) || busy || disabled || sending) return

    setSending(true)
    try {
      const text = await buildPromptWithLoadedSkill(
        loadedSkill,
        userText,
        projectRoot ?? session.cwd
      )
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
      setLoadedSkill(null)
      clearAttachments()
      resetMentions()
      resetHeight()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load skill')
    } finally {
      setSending(false)
    }
  }, [
    value,
    attachments,
    loadedSkill,
    busy,
    disabled,
    sending,
    clearAttachments,
    appOwnedTempPaths,
    onSend,
    onSendBlocks,
    resetHeight,
    resetMentions,
    projectRoot,
    session.cwd,
    session.id
  ])

  const handleSelect = useCallback(
    (item: SlashItem) => {
      if (item.kind === 'skill') {
        setLoadedSkill({ name: item.name, description: item.description ?? '' })
        setValue('')
        updateMentions('', 0)
        resetHeight()
        textareaRef.current?.focus()
        return
      }
      if (item.kind === 'command') {
        const next = applyCommandToInput(value, item.name)
        setValue(next)
        updateMentions(next, next.length)
        textareaRef.current?.focus()
        return
      }
      if (item.kind === 'config') {
        onSetConfig(item.configId, item.valueId)
      } else {
        onSetMode(item.modeId)
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
        void submit()
      }
    },
    [
      slashOpen,
      sections.length,
      handleMentionKeyDown,
      updateMentions,
      busy,
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

  const canSend =
    !disabled &&
    !sending &&
    (value.trim().length > 0 || loadedSkill !== null || attachments.length > 0)

  return (
    <div className="px-5 pb-3.5 pt-3">
      <div className="relative mx-auto w-full max-w-3xl">
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
          {loadedSkill && (
            <LoadedSkillChip skill={loadedSkill} onRemove={() => setLoadedSkill(null)} />
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
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              disabled={disabled || sending}
              rows={1}
              placeholder={
                disabled
                  ? 'Session closed'
                  : loadedSkill
                    ? 'Add a message (optional)…'
                    : 'Ask anything… (/ for commands, @ for files)'
              }
              className={cn(
                'min-h-[52px] w-full resize-none bg-transparent text-sm leading-relaxed',
                'placeholder:text-muted-foreground focus:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-50 max-h-40'
              )}
            />
          </div>
          <div className="flex items-center justify-between gap-3 px-2.5 pb-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {modelOption && (
                <ConfigChip
                  key={modelOption.id}
                  option={modelOption}
                  disabled={disabled}
                  searchable
                  maxVisibleOptions={5}
                  onSelect={(valueId) => {
                    if (modelSource === 'models') {
                      onSetModel(valueId)
                    } else {
                      onSetConfig(modelOption.id, valueId)
                    }
                  }}
                />
              )}
              {hasConfigOptions ? (
                <>
                  {thoughtLevel && (
                    <ConfigChip
                      key={thoughtLevel.id}
                      option={thoughtLevel}
                      disabled={disabled}
                      promoted
                      onSelect={(valueId) => onSetConfig(thoughtLevel.id, valueId)}
                    />
                  )}
                  {visibleGenericConfigOptions.map((option) => (
                    <ConfigChip
                      key={option.id}
                      option={option}
                      disabled={disabled}
                      onSelect={(valueId) => onSetConfig(option.id, valueId)}
                    />
                  ))}
                </>
              ) : null}
              <ModeChip session={session} disabled={disabled} onSelect={onSetMode} label="Agent" />
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              {canPick && (
                <button
                  type="button"
                  onClick={() => void pickFiles()}
                  title="Attach files"
                  aria-label="Attach files"
                  className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Paperclip size={16} />
                </button>
              )}
              <div className="relative h-[34px] w-[34px]">
                <AnimatePresence mode="popLayout" initial={false}>
                  {busy ? (
                    <motion.button
                      key="cancel"
                      type="button"
                      data-press-feedback="off"
                      onClick={onCancel}
                      title="Cancel turn"
                      aria-label="Cancel turn"
                      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: -20 }}
                      animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, rotate: 0 }}
                      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: 20 }}
                      transition={CHAT_SPRING}
                      whileTap={reduced ? undefined : { scale: 0.9 }}
                      className="absolute inset-0 flex items-center justify-center rounded-lg bg-muted text-foreground hover:bg-muted/80"
                    >
                      <Square size={14} />
                    </motion.button>
                  ) : (
                    <motion.button
                      key="send"
                      type="button"
                      data-press-feedback="off"
                      onClick={() => void submit()}
                      disabled={!canSend}
                      title="Send"
                      aria-label="Send message"
                      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: 20 }}
                      animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, rotate: 0 }}
                      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: -20 }}
                      transition={CHAT_SPRING}
                      whileTap={reduced || !canSend ? undefined : { scale: 0.9 }}
                      className={cn(
                        'absolute inset-0 flex items-center justify-center rounded-lg transition-colors',
                        canSend
                          ? 'bg-foreground text-background hover:bg-foreground/90'
                          : 'cursor-not-allowed bg-muted text-muted-foreground'
                      )}
                    >
                      <motion.span
                        key={canSend ? 'ready' : 'idle'}
                        initial={reduced ? false : { scale: 0.6 }}
                        animate={reduced ? undefined : { scale: 1 }}
                        transition={CHAT_SPRING}
                        className="flex items-center justify-center"
                      >
                        <ArrowUp size={16} strokeWidth={2.5} />
                      </motion.span>
                    </motion.button>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
        <div
          className={cn(
            'flex items-center px-1 pt-1.5 text-3xs text-muted-foreground transition-opacity duration-150',
            focused ? 'opacity-100' : 'opacity-0'
          )}
        >
          <KbdHint k="Enter" /> to send
          <span className="mx-1.5 text-border">·</span>
          <KbdHint k="Shift+Enter" /> newline
          {busy && (
            <>
              <span className="mx-1.5 text-border">·</span>
              <KbdHint k="Esc" /> to stop
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
