import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils'

const markerVariants = cva('flex min-w-0 items-center gap-2 text-xs text-muted-foreground', {
  variants: {
    variant: {
      default: '',
      border: 'border-b border-border pb-2',
      separator:
        'justify-center before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border'
    }
  },
  defaultVariants: { variant: 'default' }
})

function Marker({
  variant = 'default',
  asChild = false,
  className,
  ...props
}: React.ComponentProps<'div'> &
  VariantProps<typeof markerVariants> & {
    asChild?: boolean
  }): React.JSX.Element {
  const Comp = asChild ? Slot : 'div'
  return (
    <Comp
      data-slot="marker"
      data-variant={variant}
      className={cn(markerVariants({ variant }), className)}
      {...props}
    />
  )
}

function MarkerIcon({ className, ...props }: React.ComponentProps<'span'>): React.JSX.Element {
  return (
    <span
      data-slot="marker-icon"
      aria-hidden="true"
      className={cn('flex shrink-0 items-center [&_svg]:size-3.5', className)}
      {...props}
    />
  )
}

function MarkerContent({ className, ...props }: React.ComponentProps<'span'>): React.JSX.Element {
  return <span data-slot="marker-content" className={cn('min-w-0', className)} {...props} />
}

export { Marker, MarkerContent, MarkerIcon, markerVariants }
