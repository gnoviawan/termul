import * as SwitchPrimitives from '@radix-ui/react-switch'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { FOCUS_RING_CLASS } from './panel-styles'

/**
 * On/off switch. Track and thumb colors come from per-theme `--switch-*`
 * tokens (`.switch-track`, `.switch-thumb` in index.css). Most themes keep
 * the neutral switch: foreground track + background thumb when checked,
 * input track + muted thumb when not. Termul themes use the brand blue.
 */
export type SwitchSize = 'default' | 'sm'

/** 36x20 by default; `sm` is 28x16 for dense 28px rows. */
const TRACK_SIZE: Record<SwitchSize, string> = { default: 'h-5 w-9', sm: 'h-4 w-7' }
const THUMB_SIZE: Record<SwitchSize, string> = {
  default: 'size-4 data-[state=checked]:translate-x-4',
  sm: 'size-3 data-[state=checked]:translate-x-3'
}

/**
 * Track and thumb classes, for a switch drawn inside another control (a menu
 * item cannot hold a second button) that must still look like this one.
 */
export function switchClasses(size: SwitchSize = 'default'): { track: string; thumb: string } {
  return {
    track: cn(
      'inline-flex shrink-0 items-center rounded-full border-2 border-transparent switch-track transition-colors duration-150 ease-out',
      TRACK_SIZE[size]
    ),
    thumb: cn(
      'switch-thumb pointer-events-none block rounded-full transition-transform duration-150 ease-out motion-reduce:transition-none data-[state=unchecked]:translate-x-0',
      THUMB_SIZE[size]
    )
  }
}

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & { size?: SwitchSize }
>(({ className, size = 'default', ...props }, ref) => {
  const classes = switchClasses(size)
  return (
    <SwitchPrimitives.Root
      className={cn(
        'peer cursor-pointer disabled:cursor-not-allowed',
        classes.track,
        FOCUS_RING_CLASS,
        className
      )}
      {...props}
      ref={ref}
    >
      <SwitchPrimitives.Thumb className={classes.thumb} />
    </SwitchPrimitives.Root>
  )
})
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
