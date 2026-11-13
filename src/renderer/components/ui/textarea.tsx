import * as React from 'react'

import { cn } from '@/lib/utils'
import { FIELD_FOCUS_CLASS, FIELD_SURFACE_CLASS } from './panel-styles'

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[80px] w-full rounded-md px-3 py-2 text-sm pointer-coarse:text-base transition-colors duration-150 ease-out placeholder:text-muted-foreground disabled:cursor-not-allowed',
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
Textarea.displayName = 'Textarea'

export { Textarea }
