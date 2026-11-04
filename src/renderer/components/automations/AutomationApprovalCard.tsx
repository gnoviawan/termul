import type { NodeId, RunId } from '@shared/types/automation.types'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Hand } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { WriteGate } from '@/components/ui/write-gate'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { decideAutomationApproval } from '@/lib/automation-api'
import { formatDateTime } from './automation-format'

interface AutomationApprovalCardProps {
  runId: RunId
  nodeId: NodeId
  label: string
  until: number
  /** The rendered message; `null` while the steps load, empty when it has none. */
  message: string | null
  onDecided: () => void
}

export function AutomationApprovalCard({
  runId,
  nodeId,
  label,
  until,
  message,
  onDecided
}: AutomationApprovalCardProps): React.JSX.Element {
  const titleId = useId()
  const gated = !useServerAdmitsRemoteWrites()
  const [pending, setPending] = useState<boolean | null>(null)

  const decide = async (approved: boolean): Promise<void> => {
    setPending(approved)
    const result = await decideAutomationApproval(runId, nodeId, approved)
    setPending(null)
    if (!result.success) {
      toast.error(`Could not record the decision: ${result.error}`)
      return
    }
    if (!result.data) toast.info('This run is no longer waiting for approval.')
    onDecided()
  }

  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-3">
        <Hand size={16} className="shrink-0 text-warning" />
        <h4 id={titleId} className="min-w-0 truncate text-sm font-medium text-foreground">
          {label}
        </h4>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          Expires {formatDateTime(until)}
        </span>
      </header>
      {message === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading the message…</p>
      ) : (
        message && (
          <p className="whitespace-pre-wrap break-words px-4 py-3 text-sm text-foreground">
            {message}
          </p>
        )
      )}
      <footer className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center">
        <p className="flex-1 text-xs text-muted-foreground">
          Approve to let the run continue. Rejecting, or no decision before it expires, fails this
          step.
        </p>
        <div className="flex gap-2">
          <WriteGate gated={gated} className="flex-1 sm:flex-none">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 sm:flex-none pointer-coarse:h-11"
              disabled={gated || pending !== null}
              onClick={() => void decide(false)}
            >
              {pending === false ? 'Rejecting…' : 'Reject'}
            </Button>
          </WriteGate>
          <WriteGate gated={gated} className="flex-1 sm:flex-none">
            <Button
              size="sm"
              className="flex-1 sm:flex-none pointer-coarse:h-11"
              disabled={gated || pending !== null || message === null}
              onClick={() => void decide(true)}
            >
              {pending === true ? 'Approving…' : 'Approve'}
            </Button>
          </WriteGate>
        </div>
      </footer>
    </section>
  )
}
