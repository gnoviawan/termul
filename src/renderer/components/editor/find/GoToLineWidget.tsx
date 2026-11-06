import { motion, useReducedMotion } from 'framer-motion'
import { type FocusEvent, type KeyboardEvent, useId, useState } from 'react'
import { BAND_FOCUS_CLASS, INNER_FIELD_FOCUS_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'

interface GoToLineWidgetProps {
  currentLine: number
  lineCount: number
  /** Returns false when the entry is not a line the editor can go to. */
  onSubmit: (value: string) => boolean
  /** Escape: close and hand focus back to the editor. */
  onClose: () => void
  /** Focus moved elsewhere: close and leave focus where it went. */
  onDismiss: () => void
  /** Placement: the widget positions nothing itself. */
  className?: string
}

/** Floating "go to line" field, the find widget's sibling (VS Code's Ctrl+G). */
export function GoToLineWidget({
  currentLine,
  lineCount,
  onSubmit,
  onClose,
  onDismiss,
  className
}: GoToLineWidgetProps): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  const hintId = useId()
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)

  /** Enter jumps (or flags the entry), Escape closes; both ignored mid IME composition. */
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Safari fires compositionend before the confirming keydown, so only the
    // legacy keyCode 229 marks it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (!onSubmit(value)) setInvalid(true)
    }
  }

  /** Close like VS Code's quick input once focus leaves the widget, not when it moves inside it. */
  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDismiss()
  }

  return (
    <motion.div
      role="dialog"
      aria-label="Go to line"
      data-go-to-line-widget=""
      initial={reduceMotion ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      onBlur={handleBlur}
      className={cn(
        'w-80 max-w-[calc(100%-2.5rem)] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md',
        className
      )}
    >
      <div
        className={cn(
          'flex h-7 min-w-0 items-center rounded-lg border border-field-border bg-background pl-2 transition-colors duration-150 ease-out',
          BAND_FOCUS_CLASS
        )}
      >
        <input
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setInvalid(false)
          }}
          onKeyDown={handleKeyDown}
          placeholder="Line or line:column"
          aria-label="Go to line"
          aria-invalid={invalid}
          aria-describedby={hintId}
          spellCheck={false}
          autoComplete="off"
          data-go-to-line=""
          className={cn(
            'h-full min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground pointer-coarse:text-base',
            INNER_FIELD_FOCUS_CLASS
          )}
        />
        {/* Focus stays the neutral ring (docs/design/colors.md): a rejected entry shows here. */}
        <span
          id={hintId}
          aria-live="polite"
          className={cn(
            'shrink-0 whitespace-nowrap px-2 text-2xs tabular-nums',
            invalid ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {invalid ? `Lines 1–${lineCount}` : `Line ${currentLine} of ${lineCount}`}
        </span>
      </div>
    </motion.div>
  )
}
