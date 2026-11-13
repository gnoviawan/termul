import * as React from 'react'

import { cn } from '@/lib/utils'
import { FIELD_FOCUS_CLASS, FIELD_SURFACE_CLASS } from './panel-styles'

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-10 w-full rounded-lg px-3 py-2 text-base transition-colors duration-150 ease-out file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm pointer-coarse:text-base',
          FIELD_SURFACE_CLASS,
          FIELD_FOCUS_CLASS,
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input }
