import { ChevronDownIcon, PaperclipIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

export type QueueItemProps = ComponentProps<'li'>

export const QueueItem = ({ className, ...props }: QueueItemProps) => (
  <li className={cn('group flex flex-col gap-0.5 px-0 py-0.5 text-sm', className)} {...props} />
)

export type QueueItemContentProps = ComponentProps<'span'> & {
  completed?: boolean
}

export const QueueItemContent = ({
  completed = false,
  className,
  ...props
}: QueueItemContentProps) => (
  <span
    className={cn(
      'line-clamp-1 grow break-words',
      completed ? 'text-muted-foreground/50 line-through' : 'text-muted-foreground',
      className
    )}
    {...props}
  />
)

export type QueueItemActionsProps = ComponentProps<'div'>

export const QueueItemActions = ({ className, ...props }: QueueItemActionsProps) => (
  <div className={cn('flex gap-1', className)} {...props} />
)

export type QueueItemActionProps = Omit<ComponentProps<typeof Button>, 'variant' | 'size'>

export const QueueItemAction = ({ className, ...props }: QueueItemActionProps) => (
  <Button
    className={cn(
      'relative size-7 shrink-0 rounded-md p-0 text-muted-foreground',
      'opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-muted-foreground/10 hover:text-foreground',
      className
    )}
    size="icon"
    type="button"
    variant="ghost"
    {...props}
  />
)

export type QueueItemAttachmentProps = ComponentProps<'div'>

export const QueueItemAttachment = ({ className, ...props }: QueueItemAttachmentProps) => (
  <div className={cn('mt-0.5 flex flex-wrap gap-1.5', className)} {...props} />
)

export type QueueItemImageProps = ComponentProps<'img'>

export const QueueItemImage = ({ className, ...props }: QueueItemImageProps) => (
  <img
    alt=""
    className={cn('h-7 w-7 rounded border object-cover', className)}
    height={28}
    width={28}
    {...props}
  />
)

export type QueueItemFileProps = ComponentProps<'span'>

export const QueueItemFile = ({ children, className, ...props }: QueueItemFileProps) => (
  <span
    className={cn('flex items-center gap-1 rounded border bg-muted px-2 py-1 text-xs', className)}
    {...props}
  >
    <PaperclipIcon size={12} />
    <span className="max-w-[100px] truncate">{children}</span>
  </span>
)

export type QueueListProps = ComponentProps<typeof ScrollArea>

export const QueueList = ({ children, className, ...props }: QueueListProps) => (
  <ScrollArea className={cn('mt-1 -mb-1', className)} {...props}>
    <div className="max-h-40">
      <ul>{children}</ul>
    </div>
  </ScrollArea>
)
export type QueueSectionProps = ComponentProps<typeof Collapsible>

export const QueueSection = ({ className, defaultOpen = true, ...props }: QueueSectionProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
)

export type QueueSectionTriggerProps = ComponentProps<'button'>

export const QueueSectionTrigger = ({
  children,
  className,
  ...props
}: QueueSectionTriggerProps) => (
  <CollapsibleTrigger asChild>
    <button
      className={cn(
        'group flex w-full items-center rounded-md px-2 py-1 text-left font-medium text-muted-foreground text-sm transition-colors hover:bg-muted',
        className
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  </CollapsibleTrigger>
)

export type QueueSectionLabelProps = ComponentProps<'span'> & {
  count?: number
  label: string
  icon?: ReactNode
}

export const QueueSectionLabel = ({
  count,
  label,
  icon,
  className,
  ...props
}: QueueSectionLabelProps) => (
  <span className={cn('flex items-center gap-1.5', className)} {...props}>
    <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
    {icon}
    <span>
      {count} {label}
    </span>
  </span>
)

export type QueueSectionContentProps = ComponentProps<typeof CollapsibleContent>

export const QueueSectionContent = ({ className, ...props }: QueueSectionContentProps) => (
  <CollapsibleContent className={cn(className)} {...props} />
)

export type QueueProps = ComponentProps<'div'>

export const Queue = ({ className, ...props }: QueueProps) => (
  <div
    className={cn(
      'relative z-0 flex flex-col gap-1 rounded-t-2xl border border-b-0 border-border/60 bg-card/60 px-3 pt-2 pb-6',
      className
    )}
    {...props}
  />
)
