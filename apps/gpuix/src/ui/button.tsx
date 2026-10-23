import type { PublicInstance } from '@gpuix/react'
import { buttonProps } from '@gpuix/react/button'
import type { VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '../../../../src/renderer/components/ui/button-variants'
import { Box, type HostProps, toMouseEvent } from './internal/host'
import { Slot } from './internal/slot'

export interface ButtonProps extends HostProps, VariantProps<typeof buttonVariants> {
  asChild?: boolean
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  'data-press-feedback'?: string
}

/**
 * Same variants as the web Button (one cva table, `button-variants.ts`).
 * Behaves like `<button>`: a tab stop, Enter on key down and Space on key up
 * click it, and a disabled button neither clicks nor takes focus.
 */
const Button = forwardRef<PublicInstance, ButtonProps>(
  (
    { className, variant, size, asChild = false, disabled = false, type: _type, onClick, ...props },
    ref
  ) => {
    const classes = cn(buttonVariants({ variant, size, className }))
    if (asChild) {
      return <Slot ref={ref} {...props} className={classes} onClick={onClick} data-keep-shadow="" />
    }
    const behavior = buttonProps({
      disabled,
      tabIndex: props.tabIndex,
      onClick: (event) => onClick?.(toMouseEvent(event))
    })
    return (
      <Box
        ref={ref}
        {...props}
        className={classes}
        role="button"
        state={{ disabled, keepShadow: true }}
        native={{
          tabIndex: behavior.tabIndex ?? 0,
          onClick: behavior.onClick,
          onKeyDown: behavior.onKeyDown,
          onKeyUp: behavior.onKeyUp
        }}
        data-keep-shadow=""
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
