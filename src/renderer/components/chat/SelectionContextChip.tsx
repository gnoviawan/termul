import { useState } from 'react'
import { BlockQuote } from '@/components/icons'
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from '@/components/ui/tooltip'
import {
  type SelectionContext,
  selectionContextLabel,
  selectionContextPreview
} from '@/lib/composer/selection-context'
import { cn } from '@/lib/utils'

interface SelectionContextChipProps {
  /** 1-based position among the contexts of the same message. */
  index: number
  context: SelectionContext
  /** `0` in the timeline so keyboard users can open the full text; `-1` in the composer. */
  tabIndex?: number
  /** Keep the full-text tooltip open (the composer does this while the pill is selected). */
  forceOpen?: boolean
  className?: string
}

/**
 * Inline chip for a selection context: `Context N` plus a short preview. The
 * full selected text shows in a tooltip on hover or focus. Same inline metrics
 * as `FileChip` / `SkillChip`, so it stays in one line box in the composer and
 * in the user bubble. Removal is the composer's Backspace, like the other pills.
 */
export function SelectionContextChip({
  index,
  context,
  tabIndex,
  forceOpen = false,
  className
}: SelectionContextChipProps): React.JSX.Element {
  const label = selectionContextLabel(index)
  const preview = selectionContextPreview(context.text)
  const [open, setOpen] = useState(false)
  return (
    <Tooltip open={open || forceOpen} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          role="note"
          aria-label={`${label}: ${preview}`}
          tabIndex={tabIndex}
          data-selection-context-chip=""
          className={cn(
            'inline-flex h-[1.1em] max-w-full items-center gap-1 align-baseline leading-none',
            'text-inherit font-medium text-foreground outline-none',
            'focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring',
            className
          )}
        >
          <BlockQuote size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="shrink-0">{label}</span>
          <span className="max-w-[24ch] truncate font-normal text-muted-foreground">{preview}</span>
        </span>
      </TooltipTrigger>
      {/* Portaled: the chat list is a scroll container that would clip it. */}
      <TooltipPortal>
        <TooltipContent
          side="top"
          className={cn(
            'scroller-thin max-h-60 max-w-md overflow-auto whitespace-pre-wrap break-words text-xs',
            context.language !== undefined && 'font-mono'
          )}
        >
          {context.text}
        </TooltipContent>
      </TooltipPortal>
    </Tooltip>
  )
}
