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
import type {
  AvailableCommand,
  ContentBlock,
  SessionConfigOption,
  SessionModeState
} from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import type { AcpSession } from '@/stores/acp-store'
import { AgentBadge } from './AgentBadge'
import { ConfigChip, ModeChip } from './AgentHeader'
import { AttachmentPreviewGroup } from './AttachmentPreviewGroup'
import { ComposerPill } from './ComposerPill'
import { attachmentToBlock } from './chat-attachments'
import {
  filterDuplicateModeConfigOptions,
  partitionConfigOptions,
  resolveModelOption
} from './chat-input-bar-config'
import { CHAT_SPRING } from './chat-motion'
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

interface ChatInputBarProps {
  /** Active session — drives the agent icon and selector chips. */
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
    handlePaste,
    removeAttachment,
    clearAttachments,
    canPick,
    canDropPaste
  } = useComposerAttachments({ imageCapable, embedCapable, disabled })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<SlashMenuHandle>(null)

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

  const menuOpen = isSlashTrigger(value) && !disabled
  const filter = slashFilter(value)

  const sections = useMemo(
    () => (menuOpen ? buildSlashSections({ commands, configOptions, modes, skills, filter }) : []),
    [menuOpen, commands, configOptions, modes, skills, filter]
  )

  const resetHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [])

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
        onSendBlocks(blocks)
      } else {
        onSend(text)
      }
      setValue('')
      setLoadedSkill(null)
      clearAttachments()
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
    onSend,
    onSendBlocks,
    resetHeight,
    projectRoot,
    session.cwd
  ])

  const handleSelect = useCallback(
    (item: SlashItem) => {
      if (item.kind === 'skill') {
        setLoadedSkill({ name: item.name, description: item.description ?? '' })
        setValue('')
        resetHeight()
        textareaRef.current?.focus()
        return
      }
      if (item.kind === 'command') {
        setValue(applyCommandToInput(value, item.name))
        textareaRef.current?.focus()
        return
      }
      if (item.kind === 'config') {
        onSetConfig(item.configId, item.valueId)
      } else {
        onSetMode(item.modeId)
      }
      setValue('')
      resetHeight()
    },
    [value, onSetConfig, onSetMode, resetHeight]
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        tryHandleSlashMenuKeyDown(e, {
          menuOpen,
          sectionsLength: sections.length,
          menuRef,
          onClearInput: () => {
            setValue('')
            resetHeight()
          }
        })
      ) {
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
    [menuOpen, sections.length, busy, onCancel, submit, resetHeight]
  )

  const handleInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    setValue(el.value)
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [])

  // Load externally-seeded text (edit a message, pick a starter prompt), then
  // focus and place the cursor at the end. Keyed on a nonce so re-picking the
  // same text still applies.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the intended trigger
  useEffect(() => {
    if (seedNonce === undefined) return
    const next = seedText ?? ''
    setValue(next)
    const el = textareaRef.current
    if (!el) return
    el.focus()
    requestAnimationFrame(() => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`
      el.setSelectionRange(next.length, next.length)
    })
  }, [seedNonce])

  const canSend =
    !disabled &&
    !sending &&
    (value.trim().length > 0 || loadedSkill !== null || attachments.length > 0)

  return (
    <div className="px-5 pb-3.5 pt-3">
      <div className="relative mx-auto w-full max-w-3xl">
        {menuOpen && <SlashCommandMenu ref={menuRef} sections={sections} onSelect={handleSelect} />}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for attachments; the file picker button is the accessible path */}
        <div
          className={cn(
            'relative overflow-hidden rounded-2xl bg-secondary/40 ring-1 ring-transparent transition-[box-shadow,background-color] duration-200 focus-within:bg-secondary/60 focus-within:ring-primary/40',
            dragActive && 'ring-primary/70'
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
              onChange={handleInput}
              onKeyDown={handleKeyDown}
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
                    : 'Ask anything… (/ for commands & skills)'
              }
              className={cn(
                'w-full resize-none bg-transparent text-sm leading-relaxed',
                'placeholder:text-muted-foreground focus:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-50 max-h-40'
              )}
            />
          </div>
          <div className="flex items-center justify-between gap-3 px-2.5 pb-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <ComposerPill as="span" interactive={false}>
                <AgentBadge agentId={session.agentId} iconSize={16} className="max-w-[140px]" />
              </ComposerPill>
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
                  className="flex size-[34px] items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:scale-[0.96]"
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
                      className="absolute inset-0 flex items-center justify-center rounded-full bg-secondary text-foreground hover:bg-secondary/80"
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
                        'absolute inset-0 flex items-center justify-center rounded-full transition-colors',
                        canSend
                          ? 'bg-foreground text-background hover:bg-foreground/90'
                          : 'bg-foreground/20 text-background/70 cursor-not-allowed'
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
