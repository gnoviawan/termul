import type { PublicInstance } from '@gpuix/react'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { Field, type FieldProps } from './internal/field'
import { FIELD_FOCUS_CLASS } from './panel-styles'

export interface TextareaProps extends FieldProps {
  rows?: number
}

const Textarea = forwardRef<PublicInstance, TextareaProps>(({ className, rows, ...props }, ref) => (
  <Field
    ref={ref}
    element="textarea"
    minRows={rows}
    className={cn(
      'flex min-h-[80px] w-full rounded-md border border-field-border bg-background px-3 py-2 text-sm pointer-coarse:text-base transition-colors duration-150 ease-out placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
      FIELD_FOCUS_CLASS,
      className
    )}
    {...props}
  />
))
Textarea.displayName = 'Textarea'

export { Textarea }
