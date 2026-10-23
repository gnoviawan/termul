import { cn } from '@/lib/utils'
import { Search } from '../icons'
import { Field } from './internal/field'
import { Box } from './internal/host'
import { BAND_FOCUS_CLASS, INNER_FIELD_FOCUS_CLASS } from './panel-styles'

interface PopoverSearchBandProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  autoFocus?: boolean
  inputClassName?: string
}

/** Search row at the top of a popover: the band's bottom hairline is the field edge. */
export function PopoverSearchBand({
  value,
  onChange,
  placeholder,
  ariaLabel,
  autoFocus,
  inputClassName
}: PopoverSearchBandProps) {
  return (
    <Box
      className={cn(
        'flex h-10 items-center gap-2 border-b border-border px-3 transition-colors duration-150 ease-out',
        BAND_FOCUS_CLASS
      )}
    >
      <Search size={13} className="shrink-0 text-muted-foreground" />
      <Field
        element="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        className={cn(
          'min-w-0 flex-1 border-0 bg-transparent text-foreground placeholder:text-muted-foreground pointer-coarse:text-base',
          INNER_FIELD_FOCUS_CLASS,
          inputClassName
        )}
      />
    </Box>
  )
}
