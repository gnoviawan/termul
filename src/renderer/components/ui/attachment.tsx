import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const attachmentVariants = cva(
  'group/attachment relative flex max-w-full min-w-0 shrink-0 flex-wrap rounded-xl border bg-card text-card-foreground transition-colors has-[>a]:hover:bg-muted/50 has-[>button]:hover:bg-muted/50 data-[state=error]:border-destructive/30 data-[state=idle]:border-dashed',
  {
    variants: {
      size: {
        default: 'gap-3 p-2',
        sm: 'gap-2 p-1.5',
        xs: 'gap-2 p-1.5'
      },
      orientation: {
        horizontal: 'items-center',
        vertical: 'flex-col'
      }
    },
    defaultVariants: { size: 'default', orientation: 'horizontal' }
  }
)

function Attachment({
  className,
  state = 'done',
  size = 'default',
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<'div'> &
  VariantProps<typeof attachmentVariants> & {
    state?: 'idle' | 'uploading' | 'processing' | 'error' | 'done'
  }): React.JSX.Element {
  return (
    <div
      data-slot="attachment"
      data-state={state}
      data-size={size}
      data-orientation={orientation}
      className={cn(attachmentVariants({ size, orientation }), className)}
      {...props}
    />
  )
}

const attachmentMediaVariants = cva(
  'relative flex aspect-square shrink-0 items-center justify-center overflow-hidden rounded-lg [&_svg]:pointer-events-none group-data-[size=default]/attachment:size-10 group-data-[size=sm]/attachment:size-9 group-data-[size=xs]/attachment:size-8 group-data-[state=error]/attachment:bg-destructive/10 group-data-[state=error]/attachment:text-destructive',
  {
    variants: {
      variant: {
        icon: 'bg-muted text-muted-foreground [&_svg]:size-5',
        image:
          'bg-muted *:[img]:size-full *:[img]:object-cover *:[img]:outline *:[img]:outline-1 *:[img]:-outline-offset-1 *:[img]:outline-white/10'
      }
    },
    defaultVariants: { variant: 'icon' }
  }
)

function AttachmentMedia({
  className,
  variant = 'icon',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof attachmentMediaVariants>): React.JSX.Element {
  return (
    <div
      data-slot="attachment-media"
      data-variant={variant}
      className={cn(attachmentMediaVariants({ variant }), className)}
      {...props}
    />
  )
}

function AttachmentContent({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="attachment-content"
      className={cn('max-w-full min-w-0 flex-1', className)}
      {...props}
    />
  )
}

function AttachmentTitle({ className, ...props }: React.ComponentProps<'span'>): React.JSX.Element {
  return (
    <span
      data-slot="attachment-title"
      className={cn(
        'block max-w-full min-w-0 truncate text-sm font-medium group-data-[state=processing]/attachment:shimmer group-data-[state=uploading]/attachment:shimmer',
        className
      )}
      {...props}
    />
  )
}

function AttachmentDescription({
  className,
  ...props
}: React.ComponentProps<'span'>): React.JSX.Element {
  return (
    <span
      data-slot="attachment-description"
      className={cn(
        'block max-w-full min-w-0 truncate text-xs text-muted-foreground group-data-[state=error]/attachment:text-destructive/80',
        className
      )}
      {...props}
    />
  )
}

function AttachmentActions({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="attachment-actions"
      className={cn('flex shrink-0 items-center gap-0.5', className)}
      {...props}
    />
  )
}

function AttachmentAction({
  className,
  variant,
  size = 'icon-xs',
  ...props
}: React.ComponentProps<typeof Button>): React.JSX.Element {
  return (
    <Button
      data-slot="attachment-action"
      variant={variant ?? 'ghost'}
      size={size}
      className={cn('relative z-20', className)}
      {...props}
    />
  )
}

function AttachmentTrigger({
  className,
  asChild = false,
  type,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean
}): React.JSX.Element {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      data-slot="attachment-trigger"
      type={asChild ? undefined : (type ?? 'button')}
      className={cn('absolute inset-0 z-10 outline-none', className)}
      {...props}
    />
  )
}

function AttachmentGroup({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="attachment-group"
      className={cn(
        'flex min-w-0 gap-2 overflow-x-auto overscroll-x-contain scroll-fade-x snap-x snap-mandatory no-scrollbar [&>[data-slot=attachment]]:flex-none [&>[data-slot=attachment]]:snap-start',
        className
      )}
      {...props}
    />
  )
}

export {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger
}
