import { createContext, useContext } from 'react'
import { cn } from '@/lib/utils'

/**
 * Composer dock: the section at the top of the composer card that tells the
 * user what stopped the chat and offers the next step. One dock shows at a
 * time (turn error, stopped chat, usage limit, limit warning), so the fix
 * sits where the user types.
 *
 *   <ComposerDock tone="destructive" role="alert">
 *     <ComposerDockRow>
 *       <ComposerDockMessage title="The connection to the agent dropped.">
 *         The last turn did not finish.
 *       </ComposerDockMessage>
 *       <ComposerDockActions>…</ComposerDockActions>
 *     </ComposerDockRow>
 *   </ComposerDock>
 */

export type ComposerDockTone = 'destructive' | 'warning'

const ToneContext = createContext<ComposerDockTone>('warning')

const DOT_CLASS: Record<ComposerDockTone, string> = {
  destructive: 'bg-destructive',
  warning: 'bg-warning'
}

interface ComposerDockProps extends React.HTMLAttributes<HTMLDivElement> {
  tone: ComposerDockTone
}

/** Root: a stack of rows with a hairline under it, inside the composer card. */
export function ComposerDock({
  tone,
  className,
  children,
  ...props
}: ComposerDockProps): React.JSX.Element {
  return (
    <ToneContext.Provider value={tone}>
      <div
        data-composer-dock={tone}
        className={cn(
          'flex flex-col gap-2.5 border-b-[0.5px] border-border py-2.5 pl-4 pr-2.5',
          className
        )}
        {...props}
      >
        {children}
      </div>
    </ToneContext.Provider>
  )
}

/** One line of the dock: message on the left, actions on the right. */
export function ComposerDockRow({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex flex-wrap items-center gap-2.5', className)} {...props} />
}

/**
 * Status dot, then the lead sentence in ink and the rest muted. The dot takes
 * its colour from the dock's tone.
 */
export function ComposerDockMessage({
  title,
  children,
  className
}: {
  title: React.ReactNode
  children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const tone = useContext(ToneContext)
  return (
    <div className={cn('flex min-w-0 flex-1 items-start gap-2.5', className)}>
      <span className="flex h-5 shrink-0 items-center">
        <span aria-hidden className={cn('size-[7px] rounded-full', DOT_CLASS[tone])} />
      </span>
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-muted-foreground">
        <span className="font-medium text-foreground">{title}</span>
        {children ? <> {children}</> : null}
      </p>
    </div>
  )
}

/** Right-aligned action group; the primary action goes last. */
export function ComposerDockActions({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('ml-auto flex shrink-0 items-center gap-1.5', className)} {...props} />
}

/** Sunk well for technical details, under the message, in the message lane. */
export function ComposerDockDetails({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'ml-[17px] rounded-lg bg-background px-3 py-2.5 font-mono text-2xs text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

/** Tertiary text action (Details, New chat, Wait): muted, no fill at rest. */
export const COMPOSER_DOCK_TEXT_ACTION_CLASS =
  'h-7 px-2 text-xs font-medium text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
