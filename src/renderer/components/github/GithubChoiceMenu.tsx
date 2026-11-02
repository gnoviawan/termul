import { type ComponentPropsWithoutRef, forwardRef, type ReactNode, useId, useState } from 'react'
import { ChevronDown } from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { MobileSheetContent, SheetGroup, SheetRow } from '@/components/ui/mobile-sheet'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { Sheet, SheetTrigger } from '@/components/ui/sheet'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { cn } from '@/lib/utils'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'

interface FilterChipProps extends ComponentPropsWithoutRef<'button'> {
  /** The filter narrows the list: the chip reads as pressed. */
  active: boolean
  icon?: ReactNode
  /** A count badge after the text (the number of labels). */
  count?: number
}

/** A rounded filter chip with a chevron; it opens a menu, a picker or a sheet. */
export const FilterChip = forwardRef<HTMLButtonElement, FilterChipProps>(function FilterChip(
  { active, icon, count, className, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors duration-150 ease-out pointer-coarse:h-9 pointer-coarse:px-3 pointer-coarse:text-sm',
        active
          ? 'border-primary/60 bg-primary/10 text-foreground'
          : 'border-border text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground',
        FOCUS_RING_CLASS,
        className
      )}
      {...props}
    >
      {icon}
      <span className="max-w-40 truncate">{children}</span>
      {count !== undefined && count > 0 && (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-3xs font-medium tabular-nums text-primary-foreground">
          {count}
        </span>
      )}
      <ChevronDown size={12} aria-hidden="true" className="shrink-0" />
    </button>
  )
})

export interface ChoiceOption<T extends string> {
  value: T
  label: string
}

interface GithubChoiceMenuProps<T extends string> {
  /** What the chip filters ("State"): the menu title and the chip's accessible name prefix. */
  title: string
  icon?: ReactNode
  value: T
  options: readonly ChoiceOption<T>[]
  onChange: (value: T) => void
  /** The default value reads as not narrowing the list. */
  neutral: T
  /** Called as the menu opens (to load its choices). */
  onOpen?: () => void
}

/** A single-select filter chip: a radio dropdown on desktop, a bottom sheet on the phone shell. */
export function GithubChoiceMenu<T extends string>({
  title,
  icon,
  value,
  options,
  onChange,
  neutral,
  onOpen
}: GithubChoiceMenuProps<T>): React.JSX.Element {
  const isMobile = useMobileWebShell()
  const [open, setOpenState] = useState(false)
  const setOpen = (next: boolean): void => {
    if (next) onOpen?.()
    setOpenState(next)
  }
  const overlayId = `github-choice:${useId()}`
  useOverlayRegistration(overlayId, open && isMobile, () => setOpen(false), {
    mobileShellOnly: true
  })
  const current = options.find((o) => o.value === value)?.label ?? value
  const chip = (
    <FilterChip active={value !== neutral} icon={icon} aria-label={`${title}: ${current}`}>
      {current}
    </FilterChip>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{chip}</SheetTrigger>
        <MobileSheetContent title={title} aria-describedby={undefined}>
          <div role="radiogroup" aria-label={title}>
            <SheetGroup>
              {options.map((option) => (
                <SheetRow
                  key={option.value}
                  title={option.label}
                  accessory="check"
                  role="radio"
                  selected={option.value === value}
                  onSelect={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                />
              ))}
            </SheetGroup>
          </div>
        </MobileSheetContent>
      </Sheet>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{chip}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
