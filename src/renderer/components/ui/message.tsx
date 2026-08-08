import type * as React from 'react'

import { cn } from '@/lib/utils'

function MessageGroup({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div data-slot="message-group" className={cn('flex flex-col gap-1', className)} {...props} />
  )
}

function Message({
  align = 'start',
  className,
  ...props
}: React.ComponentProps<'div'> & {
  align?: 'start' | 'end'
}): React.JSX.Element {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        'group/message flex w-full items-end gap-2',
        align === 'end' && 'flex-row-reverse',
        className
      )}
      {...props}
    />
  )
}

function MessageAvatar({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="message-avatar"
      className={cn(
        'flex w-8 shrink-0 items-end justify-center [&_[data-slot=avatar]]:size-8',
        className
      )}
      {...props}
    />
  )
}

function MessageContent({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="message-content"
      className={cn(
        'flex w-full min-w-0 flex-col gap-1 group-data-[align=end]/message:items-end',
        className
      )}
      {...props}
    />
  )
}

function MessageHeader({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="message-header"
      className={cn('self-start text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  )
}

function MessageFooter({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        'flex items-center gap-1 text-xs text-muted-foreground group-data-[align=end]/message:flex-row-reverse',
        className
      )}
      {...props}
    />
  )
}

export { Message, MessageAvatar, MessageContent, MessageFooter, MessageGroup, MessageHeader }
