import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

type BubbleVariant =
  | 'default'
  | 'secondary'
  | 'muted'
  | 'tinted'
  | 'outline'
  | 'ghost'
  | 'destructive'

const BubbleContext = React.createContext<{ variant: BubbleVariant }>({ variant: 'default' })

const bubbleVariants = cva('group/bubble relative flex shrink-0 flex-col', {
  variants: {
    variant: {
      default: 'w-fit max-w-[80%]',
      secondary: 'w-fit max-w-[80%]',
      muted: 'w-fit max-w-[80%]',
      tinted: 'w-fit max-w-[80%]',
      outline: 'w-fit max-w-[80%]',
      ghost: 'w-full min-w-0 max-w-full shrink',
      destructive: 'w-fit max-w-[80%]'
    }
  },
  defaultVariants: { variant: 'default' }
})

function BubbleGroup({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="bubble-group"
      className={cn('flex min-w-0 flex-col gap-1', className)}
      {...props}
    />
  )
}

function Bubble({
  variant = 'default',
  align = 'start',
  className,
  ...props
}: React.ComponentProps<'div'> &
  VariantProps<typeof bubbleVariants> & {
    align?: 'start' | 'end'
  }): React.JSX.Element {
  const resolved = (variant ?? 'default') as BubbleVariant
  return (
    <BubbleContext.Provider value={{ variant: resolved }}>
      <div
        data-slot="bubble"
        data-variant={resolved}
        data-align={align}
        className={cn(
          bubbleVariants({ variant: resolved }),
          align === 'end' && 'ml-auto items-end',
          className
        )}
        {...props}
      />
    </BubbleContext.Provider>
  )
}

const bubbleContentVariants = cva(
  'w-fit max-w-full shrink-0 overflow-hidden break-words text-sm leading-relaxed [&_button]:text-left [&_button]:transition-colors [&_a]:transition-colors',
  {
    variants: {
      variant: {
        default: 'rounded-2xl px-4 py-2.5 bg-primary text-primary-foreground',
        secondary: 'rounded-2xl px-4 py-2.5 bg-secondary text-secondary-foreground',
        muted: 'rounded-2xl px-4 py-2.5 bg-muted text-foreground',
        tinted:
          'rounded-2xl px-4 py-2.5 bg-primary/15 text-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.04)]',
        outline: 'rounded-2xl px-4 py-2.5 border border-border bg-background text-foreground',
        ghost: 'w-full min-w-0 shrink bg-transparent text-foreground',
        destructive: 'rounded-2xl px-4 py-2.5 bg-destructive text-destructive-foreground'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

function BubbleContent({
  asChild = false,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  asChild?: boolean
}): React.JSX.Element {
  const { variant } = React.useContext(BubbleContext)
  const Comp = asChild ? Slot : 'div'
  return (
    <Comp
      data-slot="bubble-content"
      className={cn(
        bubbleContentVariants({ variant }),
        '[&:is(button,a)]:cursor-pointer [&:is(button,a)]:outline-none [&:is(button,a)]:focus-visible:ring-2 [&:is(button,a)]:focus-visible:ring-ring',
        className
      )}
      {...props}
    />
  )
}

const bubbleReactionsVariants = cva(
  'absolute z-10 flex w-fit items-center justify-center gap-0.5 rounded-full border border-border bg-background px-1.5 py-0.5 text-xs shadow-sm',
  {
    variants: {
      side: { top: '-top-2.5', bottom: '-bottom-2.5' },
      align: { start: 'left-2', end: 'right-2' }
    },
    defaultVariants: { side: 'bottom', align: 'end' }
  }
)

function BubbleReactions({
  side = 'bottom',
  align = 'end',
  className,
  ...props
}: React.ComponentProps<'div'> & {
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
}): React.JSX.Element {
  return (
    <div
      data-slot="bubble-reactions"
      data-side={side}
      data-align={align}
      className={cn(bubbleReactionsVariants({ side, align }), className)}
      {...props}
    />
  )
}

export { Bubble, BubbleContent, BubbleGroup, BubbleReactions }
