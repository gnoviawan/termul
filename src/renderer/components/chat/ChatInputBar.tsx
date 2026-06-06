import { ArrowUp, ChevronDown, Square } from 'lucide-react'
import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from 'react'
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
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<SlashMenuHandle>(null)

  const menuOpen = isSlashTrigger(value) && !disabled
  const filter = slashFilter(value)

  const sections = useMemo(
    () => (menuOpen ? buildSlashSections({ commands, configOptions, modes, filter }) : []),
    [menuOpen, commands, configOptions, modes, filter]
  )

  const resetHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [])

  const submit = useCallback(() => {
    const text = value.trim()
    if (!text || busy || disabled) return
    onSend(text)
    setValue('')
    resetHeight()
  }, [value, busy, disabled, onSend, resetHeight])

  const handleSelect = useCallback(
    (item: SlashItem) => {
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
      // config/mode selections do not touch the input; close the menu by clearing the slash token
      setValue('')
      resetHeight()
    },
    [value, onSetConfig, onSetMode, resetHeight]
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // When the slash menu is open with items, route navigation/selection to it.
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
          // Enter selects the highlighted item; it must NOT send the prompt.
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
        // fall through for typing/Backspace so the filter updates
      }

      // Esc cancels an in-flight turn (when the menu isn't open).
      if (e.key === 'Escape' && busy) {
        e.preventDefault()
        onCancel()
        return
      }
      // Enter sends; Shift+Enter newline; ignore during IME composition.
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submit()
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

  const canSend = !disabled && value.trim().length > 0

  return (
    <div className="px-5 pb-3.5 pt-3">
      <div className="relative mx-auto w-full max-w-3xl">
        {menuOpen && <SlashCommandMenu ref={menuRef} sections={sections} onSelect={handleSelect} />}
        <div className="overflow-hidden rounded-2xl bg-secondary/40">
          <div className="px-4 pb-1.5 pt-3.5">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              rows={1}
              placeholder={disabled ? 'Session closed' : 'Ask anything… (/ for commands)'}
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
                  onClick={submit}
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
