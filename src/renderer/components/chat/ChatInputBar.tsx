import { useState, useRef, useCallback, useMemo, type KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SlashCommandMenu, type SlashMenuHandle } from './SlashCommandMenu'
import {
  buildSlashSections,
  isSlashTrigger,
  slashFilter,
  applyCommandToInput,
  type SlashItem
} from './slash-menu-model'
import type { AvailableCommand, SessionConfigOption, SessionModeState } from '@/lib/acp-api'

interface ChatInputBarProps {
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

  return (
    <div className="relative flex items-end gap-2 border-t border-border/60 bg-card/40 p-2">
      {menuOpen && <SlashCommandMenu ref={menuRef} sections={sections} onSelect={handleSelect} />}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
        placeholder={disabled ? 'Session closed' : 'Type a message, or / for commands…'}
        className={cn(
          'flex-1 resize-none rounded-md border border-border/60 bg-background px-3 py-2 text-sm',
          'placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40',
          'disabled:cursor-not-allowed disabled:opacity-50 max-h-40'
        )}
      />
      {busy ? (
        <button
          type="button"
          onClick={onCancel}
          title="Cancel turn"
          aria-label="Cancel turn"
          className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary text-foreground hover:bg-secondary/80"
        >
          <Square size={14} />
        </button>
      ) : (
        <button
          type="button"
          onClick={submit}
          disabled={disabled || value.trim().length === 0}
          title="Send"
          aria-label="Send message"
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground',
            'hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          <Send size={14} />
        </button>
      )}
    </div>
  )
}
