import * as SwitchPrimitives from '@radix-ui/react-switch'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Neutral on/off switch. Checked: foreground track + background thumb.
 * Unchecked: input track + muted thumb. Blue is not used — a setting
 * being on is not live work (docs/design/colors.md, State).
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-150 ease-out data-[state=checked]:bg-foreground data-[state=unchecked]:bg-input focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className="pointer-events-none block size-4 rounded-full shadow-sm ring-0 transition-transform duration-150 ease-out data-[state=checked]:translate-x-4 data-[state=checked]:bg-background data-[state=unchecked]:translate-x-0 data-[state=unchecked]:bg-muted-foreground"
      data-keep-shadow=""
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
