import type { PublicInstance } from '@gpuix/react'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { Field, type FieldProps } from './internal/field'
import { FIELD_FOCUS_CLASS } from './panel-styles'

export type InputProps = FieldProps

const Input = forwardRef<PublicInstance, InputProps>(({ className, ...props }, ref) => (
  <Field
    ref={ref}
    element="input"
    className={cn(
      'flex h-10 w-full rounded-lg border border-field-border bg-background px-3 py-2 text-base transition-colors duration-150 ease-out file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm pointer-coarse:text-base',
      FIELD_FOCUS_CLASS,
      className
    )}
    {...props}
  />
))
Input.displayName = 'Input'

export { Input }
