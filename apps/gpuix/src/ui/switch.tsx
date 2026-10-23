import type { PublicInstance } from '@gpuix/react'
import { buttonProps } from '@gpuix/react/button'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { Box, type HostProps } from './internal/host'
import { useControllableState } from './internal/overlay'

export interface SwitchProps extends Omit<HostProps, 'children'> {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  required?: boolean
  name?: string
  value?: string
}

const TRACK_CLASS =
  'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-150 ease-out data-[state=checked]:bg-foreground data-[state=unchecked]:bg-input focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

const THUMB_CLASS =
  'pointer-events-none block size-4 rounded-full shadow-sm ring-0 transition-transform duration-150 ease-out data-[state=checked]:translate-x-4 data-[state=checked]:bg-background data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-muted-foreground'

/** `translate-x-4` (16px) on the thumb, as a margin: GPUIX has no transforms. */
const THUMB_TRAVEL = 16

/**
 * Neutral on/off switch with Radix Switch's contract: `checked` /
 * `defaultChecked` / `onCheckedChange`, `data-state`, Space and Enter toggle.
 */
const Switch = forwardRef<PublicInstance, SwitchProps>(
  (
    { className, checked, defaultChecked = false, onCheckedChange, disabled = false, ...props },
    ref
  ) => {
    const [on, setOn] = useControllableState(checked, defaultChecked, onCheckedChange)
    const state = on ? 'checked' : 'unchecked'
    const behavior = buttonProps({ disabled, tabIndex: props.tabIndex, onClick: () => setOn(!on) })
    return (
      <Box
        ref={ref}
        {...props}
        role="switch"
        aria-checked={on}
        data-state={state}
        data-disabled={disabled ? '' : undefined}
        className={cn(TRACK_CLASS, className)}
        state={{ disabled }}
        native={{
          tabIndex: behavior.tabIndex ?? 0,
          onClick: behavior.onClick,
          onKeyDown: behavior.onKeyDown,
          onKeyUp: behavior.onKeyUp
        }}
      >
        <Box
          className={THUMB_CLASS.replace(/\S*translate-x-\S+/g, '')}
          data-state={state}
          state={{ keepShadow: true }}
          style={{ marginLeft: on ? THUMB_TRAVEL : 0 }}
        />
      </Box>
    )
  }
)
Switch.displayName = 'Switch'

export { Switch }
