import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Filled primary chrome for `default` and `composer`.
 * Layered emboss, hover mix that keeps the hue, muted disabled fill.
 * Send, stop, and launch use `composer`. Other primary actions use `default`.
 * One filled primary per view. The glyph is the only difference at the call site.
 */
const primaryEmboss =
  'bg-primary-fill text-primary-foreground active:scale-[0.96] motion-reduce:active:scale-100 transition-[scale,background-color,box-shadow] duration-150 ease-out hover:bg-[color-mix(in_oklch,oklch(var(--primary-fill))_85%,black)] disabled:bg-muted disabled:text-disabled-foreground disabled:opacity-100 disabled:hover:bg-muted disabled:shadow-none shadow-[0_1px_2px_oklch(0_0_0/0.22),0_4px_8px_oklch(0_0_0/0.16),inset_0_1px_0_oklch(1_0_0/0.28),inset_0_-1px_1px_oklch(0_0_0/0.16)] hover:shadow-[0_1px_2px_oklch(0_0_0/0.26),0_5px_10px_oklch(0_0_0/0.2),inset_0_1px_0_oklch(1_0_0/0.34),inset_0_-1px_1px_oklch(0_0_0/0.2)]'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: primaryEmboss,
        destructive: 'bg-destructive-fill text-destructive-foreground hover:bg-destructive-fill/90',
        outline:
          'border border-input bg-background hover:bg-secondary hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-secondary hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        composer: primaryEmboss
      },
      size: {
        default: 'h-10 px-4 py-2',
        xs: 'h-7 rounded-md px-2 text-xs',
        sm: 'h-9 rounded-lg px-3',
        lg: 'h-11 rounded-lg px-8',
        icon: 'h-10 w-10',
        'icon-xs': 'h-6 w-6 rounded-md',
        'icon-sm': 'h-8 w-8 rounded-lg',
        'icon-lg': 'h-10 w-10',
        // 44px visual floor for mobile paths. `relative` anchors the
        // ::after hit-slop overlay (−inset-1.5 → ~48×48 tappable) without
        // growing layout chrome — same idiom as AttachFilesButton.
        touch: "h-11 relative after:absolute after:-inset-1.5 after:content-['']"
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

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
        data-press-feedback={pressFeedback ?? (ownsPressScale ? 'off' : undefined)}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
