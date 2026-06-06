import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, Square, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  buildPromptWithLoadedSkill,
  type LoadedAgentSkill,
  useAgentSkills
} from '@/hooks/use-agent-skills'
import type { AvailableCommand, SessionConfigOption, SessionModeState } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import type { AcpSession } from '@/stores/acp-store'
import { AgentBadge } from './AgentBadge'
import { ConfigChip, ModeChip } from './AgentHeader'
import { partitionConfigOptions } from './chat-input-bar-config'
import { SlashCommandMenu, type SlashMenuHandle } from './SlashCommandMenu'
import {
  applyCommandToInput,
  buildSlashSections,
  isSlashTrigger,
  type SlashItem,
  slashFilter
} from './slash-menu-model'

interface ChatInputBarProps {
  /** Active session — drives the agent icon and selector chips. */
  session: AcpSession
  /** Project/worktree root used to discover project-local skills. */
  projectRoot?: string
  /** Whether a prompt turn is currently active (disables send, enables cancel). */
  busy: boolean
  /** Whether the session is closed/disconnected (fully disables input). */
  disabled: boolean
  onSend: (text: string) => void
  onCancel: () => void
  /** Slash-menu data sources from the active session. */
  commands: AvailableCommand[]
  configOptions: SessionConfigOption[]
  modes: SessionModeState | null
  /** Apply a config option value immediately. */
  onSetConfig: (configId: string, valueId: string) => void
  /** Apply a legacy mode immediately. */
  onSetMode: (modeId: string) => void
}

export function ChatInputBar({
  session,
  projectRoot,
  busy,
  disabled,
  onSend,
  onCancel,
  commands,
  configOptions,
  modes,
  onSetConfig,
  onSetMode
}: ChatInputBarProps): React.JSX.Element {
  const usableConfigOptions = configOptions.filter((o) => o.options.length > 0)
  const hasConfigOptions = usableConfigOptions.length > 0
  const { thoughtLevel, rest: genericConfigOptions } = partitionConfigOptions(usableConfigOptions)
  const { skills } = useAgentSkills(projectRoot ?? session.cwd)
  const [value, setValue] = useState('')
  const [loadedSkill, setLoadedSkill] = useState<LoadedAgentSkill | null>(null)
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<SlashMenuHandle>(null)

  const menuOpen = isSlashTrigger(value) && !disabled
  const filter = slashFilter(value)

  const sections = useMemo(
    () =>
      menuOpen
        ? buildSlashSections({ commands, configOptions, modes, skills, filter })
        : [],
    [menuOpen, commands, configOptions, modes, skills, filter]
  )

  const resetHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [])

  const submit = useCallback(async () => {
    const userText = value.trim()
    if ((!userText && !loadedSkill) || busy || disabled || sending) return

    setSending(true)
    try {
      const text = await buildPromptWithLoadedSkill(
        loadedSkill,
        userText,
        projectRoot ?? session.cwd
      )
      if (!text.trim()) return
      onSend(text)
      setValue('')
      setLoadedSkill(null)
      resetHeight()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load skill')
    } finally {
      setSending(false)
    }
  }, [
    value,
    loadedSkill,
    busy,
    disabled,
    sending,
    onSend,
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
      if (menuOpen && sections.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          menuRef.current?.move(1)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          menuRef.current?.move(-1)
          return
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && sections.length > 0) {
          e.preventDefault()
          menuRef.current?.selectHighlighted()
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setValue('')
          resetHeight()
          return
        }
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

  const canSend = !disabled && !sending && (value.trim().length > 0 || loadedSkill !== null)

  return (
    <div className="px-5 pb-3.5 pt-3">
      <div className="relative mx-auto w-full max-w-3xl">
        {menuOpen && <SlashCommandMenu ref={menuRef} sections={sections} onSelect={handleSelect} />}
        <div className="overflow-hidden rounded-2xl bg-secondary/40">
          {loadedSkill && (
            <div className="flex items-start gap-2 border-b border-border/40 px-4 py-1.5">
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                Skill:{' '}
                <span className="font-medium text-foreground break-words">{loadedSkill.name}</span>
              </span>
              <button
                type="button"
                onClick={() => setLoadedSkill(null)}
                className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                aria-label="Remove loaded skill"
                title="Remove skill"
              >
                <X size={12} />
              </button>
            </div>
          )}
          <div className="px-4 pb-1.5 pt-3.5">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
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
              <span className="flex h-[30px] items-center gap-1.5 rounded-lg bg-foreground/[0.06] px-2.5 text-xs text-foreground/80">
                <AgentBadge agentId={session.agentId} iconSize={16} className="max-w-[140px]" />
                <ChevronDown size={11} className="text-muted-foreground" />
              </span>
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
                  {genericConfigOptions.map((option) => (
                    <ConfigChip
                      key={option.id}
                      option={option}
                      disabled={disabled}
                      onSelect={(valueId) => onSetConfig(option.id, valueId)}
                    />
                  ))}
                </>
              ) : (
                <ModeChip session={session} disabled={disabled} onSelect={onSetMode} />
              )}
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              {busy ? (
                <button
                  type="button"
                  onClick={onCancel}
                  title="Cancel turn"
                  aria-label="Cancel turn"
                  className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-secondary text-foreground hover:bg-secondary/80"
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!canSend}
                  title="Send"
                  aria-label="Send message"
                  className={cn(
                    'flex h-[34px] w-[34px] items-center justify-center rounded-full transition-colors',
                    canSend
                      ? 'bg-foreground text-background hover:bg-foreground/90'
                      : 'bg-foreground/20 text-background/70 cursor-not-allowed'
                  )}
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
