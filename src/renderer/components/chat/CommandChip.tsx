import { TerminalSquare, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface CommandChipProps {
  name: string
  onRemove: () => void
  className?: string
}

/** Shows the active slash command above a prompt input as a chip. */
export function CommandChip({ name, onRemove, className }: CommandChipProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  return (
    <div className={cn('flex items-start gap-2 border-b border-border/40 px-4 py-1.5', className)}>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
        <TerminalSquare size={12} className="shrink-0" />
        <span className="font-medium text-foreground break-words">/{name}</span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-auto shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        aria-label={t('commandChip.remove', { name })}
        title={t('commandChip.removeTitle')}
      >
        <X size={12} />
      </button>
    </div>
  )
}
