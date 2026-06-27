import { Check, Copy, Pencil, RotateCcw } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { copyText } from '@/lib/copy-text'
import { cn } from '@/lib/utils'

interface ActionButtonProps {
  label: string
  onClick: () => void
  children: React.ReactNode
}

function ActionButton({ label, onClick, children }: ActionButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:scale-[0.96] [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

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
 * retry (assistant turns). Hover-revealed by default; pinned stays visible.
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
        'flex items-center gap-0.5 transition-opacity duration-150 focus-within:opacity-100',
        pinned ? 'opacity-100' : 'opacity-0 group-hover/message:opacity-100',
        align === 'end' && 'flex-row-reverse',
        className
      )}
    >
      <ActionButton label={copied ? 'Copied' : 'Copy'} onClick={copy}>
        {copied ? <Check className="text-green-400" /> : <Copy />}
      </ActionButton>
      {onEdit && (
        <ActionButton label="Edit" onClick={onEdit}>
          <Pencil />
        </ActionButton>
      )}
      {onRetry && (
        <ActionButton label="Retry" onClick={onRetry}>
          <RotateCcw />
        </ActionButton>
      )}
    </div>
  )
}
