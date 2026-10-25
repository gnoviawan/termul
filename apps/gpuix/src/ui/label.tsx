import type { PublicInstance } from '@gpuix/react'
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'
import type { InlineLevel } from '../compat/children'
import { Box, type HostProps } from './internal/host'

const labelVariants = cva(
  'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70'
)

export interface LabelProps extends HostProps, VariantProps<typeof labelVariants> {
  htmlFor?: string
}

/** `peer-disabled:` needs the sibling's state, which GPUIX cannot select; it is dropped. */
const Label = forwardRef<PublicInstance, LabelProps>(
  ({ className, htmlFor: _htmlFor, ...props }, ref) => (
    <Box
      ref={ref}
      {...props}
      className={cn(labelVariants(), className).replace(/peer-disabled:\S+/g, '')}
    />
  )
)
Label.displayName = 'Label'
// The web's Radix Label renders an inline `<label>`: in a block container it sits on the strut's line.
;(Label as InlineLevel).inlineLevel = true

export { Label }
