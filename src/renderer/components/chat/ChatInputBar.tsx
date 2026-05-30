import { useState, useRef, useCallback, type KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ChatInputBarProps {
  /** Whether a prompt turn is currently active (disables send, enables cancel). */
  busy: boolean
  /** Whether the session is closed/disconnected (fully disables input). */
  disabled: boolean
  onSend: (text: string) => void
  onCancel: () => void
}

export function ChatInputBar({
  busy,
  disabled,
  onSend,
  onCancel
}: ChatInputBarProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const submit = useCallback(() => {
    const text = value.trim()
    if (!text || busy || disabled) return
    onSend(text)
    setValue('')
    // reset height after clearing
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, busy, disabled, onSend])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Esc cancels an in-flight turn.
      if (e.key === 'Escape' && busy) {
        e.preventDefault()
        onCancel()
        return
      }
      // Enter sends; Shift+Enter inserts a newline. Ignore Enter while an IME
      // composition is active (CJK candidate confirmation), so partial text is
      // not submitted prematurely.
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submit()
      }
    },
    [submit, busy, onCancel]
  )

  const handleInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    setValue(el.value)
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [])

  return (
    <div className="flex items-end gap-2 border-t border-border/60 bg-card/40 p-2">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
        placeholder={disabled ? 'Session closed' : 'Type a message…'}
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
