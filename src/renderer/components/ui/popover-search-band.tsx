import { Search } from '@/components/icons'
import { cn } from '@/lib/utils'
import { FOCUS_RING_CLASS } from './panel-styles'

interface PopoverSearchBandProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  autoFocus?: boolean
  /** Text size and height for the input (for example `text-xs`). */
  inputClassName?: string
}

/**
 * Search field as a 40px band at the top of a popover or picker shell, with
 * a hairline below. No recessed input box: the band is the field.
 */
export function PopoverSearchBand({
  value,
  onChange,
  placeholder,
  ariaLabel,
  autoFocus,
  inputClassName
}: PopoverSearchBandProps): React.JSX.Element {
  return (
    <div className="flex h-10 items-center gap-2 border-b border-border px-3">
      <Search size={13} aria-hidden="true" className="shrink-0 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        className={cn(
          'min-w-0 flex-1 border-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground',
          FOCUS_RING_CLASS,
          inputClassName
        )}
      />
    </div>
  )
}
