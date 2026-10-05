import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, Pencil, RotateCcw } from '@/components/icons'
import { IconActionButton } from '@/components/ui/icon-action-button'
import { IconSwap } from '@/components/ui/icon-swap'
import { copyText } from '@/lib/copy-text'
import { cn } from '@/lib/utils'

interface MessageActionsProps {
  /** Plain text to place on the clipboard for the copy action. */
  text: string
  align: 'start' | 'end'
  /** Keep actions visible without hover (e.g. last message in thread). */
  pinned?: boolean
  /** Edit the message (e.g. seed the composer with this text). */
  onEdit?: () => void
  /** Re-run the turn (regenerate the response). */
  onRetry?: () => void
  className?: string
}

/**
 * Toolbar for a chat message — copy, plus optional edit (user turns) and
 * retry (assistant turns). Fine-pointer: hover-revealed (pinned stays visible).
 * Coarse pointer / touch: always soft-visible so actions stay discoverable.
 * No action pill: icons flush with prose left edge (assistant) / bubble (user).
 */
export function MessageActions({
  text,
  align,
  pinned = false,
  onEdit,
  onRetry,
  className
}: MessageActionsProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    if (!text) return
    void copyText(text).then((ok) => {
      if (!ok) {
        toast.error('Failed to copy')
        return
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [text])

  return (
    <div
      className={cn(
        // Compact icon row; the gap keeps the ~44px pseudo-element hit
        // areas (#859) close to tiling without dead space.
        'flex items-center gap-2.5 transition-opacity duration-150 focus-within:opacity-100',
        // Touch / coarse: always visible. Fine pointer: hover-reveal unless pinned.
        pinned
          ? 'opacity-100'
          : 'opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover/message:opacity-100',
        align === 'start' && '-ml-1',
        align === 'end' && 'justify-end -mr-1',
        className
      )}
    >
      <div className={cn('flex items-center gap-2.5', align === 'end' && 'flex-row-reverse')}>
        <IconActionButton
          size="sm"
          label={copied ? 'Copied' : 'Copy'}
          onClick={copy}
          className="rounded-md hover:bg-secondary/60 active:scale-[0.96] transition-[transform,color,background-color] duration-150"
        >
          <IconSwap iconKey={copied}>
            {copied ? <Check className="text-success" /> : <Copy />}
          </IconSwap>
        </IconActionButton>
        {onEdit && (
          <IconActionButton
            size="sm"
            label="Edit"
            onClick={onEdit}
            className="rounded-md hover:bg-secondary/60 active:scale-[0.96] transition-[transform,color,background-color] duration-150"
          >
            <Pencil />
          </IconActionButton>
        )}
        {onRetry && (
          <IconActionButton
            size="sm"
            label="Retry"
            onClick={onRetry}
            className="rounded-md hover:bg-secondary/60 active:scale-[0.96] transition-[transform,color,background-color] duration-150"
          >
            <RotateCcw />
          </IconActionButton>
        )}
      </div>
    </div>
  )
}
