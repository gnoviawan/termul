import { useRef } from 'react'
import { Search, X } from '@/components/icons'
import {
  PANEL_FIELD_CLASS,
  PANEL_FIELD_ICON_CLASS,
  QUIET_ICON_BUTTON_CLASS
} from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'

/** `md` = Projects panel (32px), `sm` = per-project chat list (28px). */
const SIZE_CLASSES = {
  md: { input: 'h-8 pl-8', clear: 'right-1.5' },
  sm: { input: 'h-7 pl-7', clear: 'right-1' }
} as const

export interface SidebarSearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  clearLabel: string
  size: keyof typeof SIZE_CLASSES
  /** Prefix for `-input` / `-clear` test ids. */
  testIdPrefix?: string
}

/**
 * Sidebar search field: panel field with a search glyph and a clear button.
 * Escape clears a non-empty query without bubbling; clearing returns focus to
 * the input (the clear button unmounts).
 */
export function SidebarSearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearLabel,
  size,
  testIdPrefix
}: SidebarSearchFieldProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const sizeClasses = SIZE_CLASSES[size]

  return (
    <div className="relative">
      <Search size={13} className={PANEL_FIELD_ICON_CLASS} aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            e.stopPropagation()
            onChange('')
          }
        }}
        className={cn(
          PANEL_FIELD_CLASS,
          'w-full pr-7 [&::-webkit-search-cancel-button]:hidden',
          sizeClasses.input
        )}
        aria-label={ariaLabel}
        data-testid={testIdPrefix && `${testIdPrefix}-input`}
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
          className={cn(
            QUIET_ICON_BUTTON_CLASS,
            'absolute top-1/2 size-5 -translate-y-1/2',
            sizeClasses.clear
          )}
          title="Clear search"
          aria-label={clearLabel}
          data-testid={testIdPrefix && `${testIdPrefix}-clear`}
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
}
