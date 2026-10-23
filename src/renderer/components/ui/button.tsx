import { Slot } from '@radix-ui/react-slot'
import type { VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'
import { buttonVariants } from './button-variants'

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  'data-press-feedback'?: string
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, 'data-press-feedback': pressFeedback, ...props },
    ref
  ) => {
    const Comp = asChild ? Slot : 'button'
    // Primary chrome scales itself to 0.96. The document press rule also
    // sets transform: scale(0.96). Both together land near 0.92.
    const ownsPressScale = variant == null || variant === 'default' || variant === 'composer'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
        data-keep-shadow=""
        data-press-feedback={pressFeedback ?? (ownsPressScale ? 'off' : undefined)}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
