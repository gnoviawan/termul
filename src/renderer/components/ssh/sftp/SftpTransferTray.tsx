import type { SFTPTransferProgress } from '@shared/types/ssh.types'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowDown, ArrowUp } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { localFileName } from '@/hooks/use-sftp-transfers'
import { formatSize } from '@/lib/sftp-format'
import { cn } from '@/lib/utils'
import { useSSHActions, useSSHTransfers } from '@/stores/ssh-store'

const TRAY_ENTER = { duration: 0.2, ease: [0.23, 1, 0.32, 1] as const }
const TRAY_EXIT = { duration: 0.15, ease: [0.23, 1, 0.32, 1] as const }

function statusText(t: SFTPTransferProgress): string {
  if (t.status === 'completed') return 'Done'
  if (t.status === 'failed') return t.error ?? 'Failed'
  if (t.status === 'cancelled') return 'Cancelled'
  if (t.totalBytes === 0) return 'Waiting'
  return `${formatSize(t.bytesTransferred)} of ${formatSize(t.totalBytes)}`
}

function TransferRow({ transfer }: { transfer: SFTPTransferProgress }): React.JSX.Element {
  const name = localFileName(transfer.remotePath)
  const upload = transfer.direction === 'upload'
  const ratio =
    transfer.status === 'completed'
      ? 1
      : transfer.totalBytes > 0
        ? Math.min(1, transfer.bytesTransferred / transfer.totalBytes)
        : 0
  const failed = transfer.status === 'failed'
  const status = statusText(transfer)
  return (
    <li className="space-y-1.5 px-3 py-2" data-testid="sftp-transfer" data-status={transfer.status}>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {upload ? (
          <ArrowUp size={12} className="shrink-0 text-muted-foreground" aria-label="Upload" />
        ) : (
          <ArrowDown size={12} className="shrink-0 text-muted-foreground" aria-label="Download" />
        )}
        <span className="min-w-0 flex-1 truncate text-foreground" title={transfer.remotePath}>
          {name}
        </span>
        <span
          className={cn(
            'max-w-32 shrink-0 truncate text-3xs tabular-nums',
            failed
              ? 'text-destructive'
              : transfer.status === 'completed'
                ? 'text-success'
                : 'text-muted-foreground'
          )}
          title={failed ? status : undefined}
        >
          {status}
        </span>
      </div>
      <div
        className="h-0.5 overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-label={`${upload ? 'Uploading' : 'Downloading'} ${name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <div
          className={cn(
            'h-full w-full origin-left rounded-full transition-transform duration-150 ease-linear',
            failed
              ? 'bg-destructive'
              : transfer.status === 'completed'
                ? 'bg-success'
                : 'bg-primary'
          )}
          style={{ transform: `scaleX(${ratio})` }}
        />
      </div>
    </li>
  )
}

/** Uploads and downloads of one connection, newest last. */
export function SftpTransferTray({ connectionId }: { connectionId: string }): React.JSX.Element {
  const transfers = useSSHTransfers().filter((t) => t.connectionId === connectionId)
  const { clearCompletedTransfers } = useSSHActions()
  const reducedMotion = useReducedMotion() ?? false
  const active = transfers.filter((t) => t.status === 'in-progress').length
  const finished = transfers.length - active

  return (
    <AnimatePresence initial={false}>
      {transfers.length > 0 && (
        <motion.section
          key="transfers"
          className="shrink-0 border-t border-border"
          aria-label="Transfers"
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(4px)' }}
          animate={{ opacity: 1, transform: 'translateY(0px)' }}
          exit={{ opacity: 0, transition: TRAY_EXIT }}
          transition={TRAY_ENTER}
        >
          <div className="flex h-8 items-center gap-1.5 pl-3 pr-1.5">
            <h3 className="label-panel">Transfers</h3>
            {active > 0 && (
              <span className="text-2xs tabular-nums text-muted-foreground">{active} active</span>
            )}
            <span className="flex-1" />
            {finished > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-6 px-2 text-muted-foreground"
                onClick={() => clearCompletedTransfers(connectionId)}
              >
                Clear finished
              </Button>
            )}
          </div>
          <ul className="max-h-40 overflow-y-auto pb-1">
            {transfers.map((t) => (
              <TransferRow key={`${t.direction}:${t.remotePath}`} transfer={t} />
            ))}
          </ul>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
