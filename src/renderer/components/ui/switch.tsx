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
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent switch-track transition-colors duration-150 ease-out disabled:cursor-not-allowed',
      FOCUS_RING_CLASS,
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb className="switch-thumb pointer-events-none block size-4 rounded-full transition-transform duration-150 ease-out data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
