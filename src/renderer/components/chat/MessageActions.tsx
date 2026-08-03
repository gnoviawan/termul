import { Check, Copy, Pencil, RotateCcw } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
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
        // -ml-1 pulls the size-6 visual box so the 14px glyph lines up with prose.
        'flex items-center gap-0.5 transition-opacity duration-150 focus-within:opacity-100',
        // Touch / coarse: always visible. Fine pointer: hover-reveal unless pinned.
        pinned
          ? 'opacity-100'
          : 'opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover/message:opacity-100',
        align === 'start' && '-ml-1',
        align === 'end' && 'justify-end',
        className
      )}
    >
      <div className={cn('flex items-center gap-0.5', align === 'end' && 'flex-row-reverse')}>
        <IconActionButton label={copied ? 'Copied' : 'Copy'} onClick={copy}>
          <IconSwap iconKey={copied}>
            {copied ? <Check className="text-success" /> : <Copy />}
          </IconSwap>
        </IconActionButton>
        {onEdit && (
          <IconActionButton label="Edit" onClick={onEdit}>
            <Pencil />
          </IconActionButton>
        )}
        {onRetry && (
          <IconActionButton label="Retry" onClick={onRetry}>
            <RotateCcw />
          </IconActionButton>
        )}
      </div>
    </div>
  )
}
