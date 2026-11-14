import { useState } from 'react'
import { Download } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { WriteGate } from '@/components/ui/write-gate'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { cn } from '@/lib/utils'
import { ImportChatsDialog } from './ImportChatsDialog'

interface ImportChatsButtonProps {
  /** Working copy whose agent chats are offered. Empty hides the button. */
  cwd: string
  projectId: string
  className?: string
}

/**
 * The phone drawer's full-width "Import chats" row button: opens the
 * "Import chats" dialog. Importing writes to the host, so a server that
 * refuses remote writes shows the button disabled with the reason. (The
 * desktop Rail offers the import in its Projects `+` menu.)
 */
export function ImportChatsButton({
  cwd,
  projectId,
  className
}: ImportChatsButtonProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const admitted = useServerAdmitsRemoteWrites()
  if (cwd.trim().length === 0) return null

  return (
    <>
      <WriteGate gated={!admitted} className="flex w-full">
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
      </WriteGate>
      <ImportChatsDialog open={open} onOpenChange={setOpen} cwd={cwd} projectId={projectId} />
    </>
  )
}
