import { useState } from 'react'
import { Download } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { WriteGate } from '@/components/ui/write-gate'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { cn } from '@/lib/utils'
import { ImportChatsDialog } from './ImportChatsDialog'

interface ImportChatsButtonProps {
  /** Working copy whose agent chats are offered. Empty hides the button. */
  cwd: string
  projectId: string
  /** `icon`: panel icon button (desktop Chats tab). `row`: full-width text button (phone drawer). */
  variant: 'icon' | 'row'
  className?: string
}

/**
 * Opens the "Import chats" dialog. Importing writes to the host, so a server
 * that refuses remote writes shows the button disabled with the reason.
 */
export function ImportChatsButton({
  cwd,
  projectId,
  variant,
  className
}: ImportChatsButtonProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const admitted = useServerAdmitsRemoteWrites()
  if (cwd.trim().length === 0) return null

  const trigger =
    variant === 'icon' ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!admitted}
        className={cn(PANEL_ICON_BUTTON_CLASS, 'shrink-0 disabled:opacity-40', className)}
        title="Import chats"
        aria-label="Import chats"
      >
        <Download size={14} aria-hidden="true" />
      </button>
    ) : (
      <Button
        variant="ghost"
        size="touch"
        onClick={() => setOpen(true)}
        disabled={!admitted}
        className={cn('w-full justify-start gap-3 rounded-full px-4 text-base', className)}
      >
        <Download size={16} aria-hidden="true" />
        Import chats
      </Button>
    )

  return (
    <>
      <WriteGate gated={!admitted} className={variant === 'row' ? 'flex w-full' : undefined}>
        {trigger}
      </WriteGate>
      <ImportChatsDialog open={open} onOpenChange={setOpen} cwd={cwd} projectId={projectId} />
    </>
  )
}
