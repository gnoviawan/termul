import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { PromptCommandState } from '@/stores/acp-store/types'
import { AgentConnectionLamp } from './AgentConnectionLamp'

interface PromptReconcileNoticeProps {
  state: PromptCommandState
  /** Manual same-id re-check: asks the host about THIS turn again (never a new send). */
  onRecheck: () => void
}

/**
 * AD-6 pending-reconcile state: the connection dropped before the host
 * confirmed the prompt, and the app is resending the same turn. Not an error —
 * the message stays in the transcript and the composer stays busy until the
 * host answers. Two labels:
 *
 * - "Waiting to confirm…": the same turn id is being resent automatically.
 * - "Checking…": a manual re-check (same id) is in flight; the button is disabled.
 * - "Outcome unknown — check": the host no longer knows whether it ran this
 *   turn and will not run it again; nothing is resent automatically, the user
 *   checks (re-check asks again with the SAME id; Stop abandons the turn).
 *
 * Non-blocking; announces itself politely.
 */
export function PromptReconcileNotice({ state, onRecheck }: PromptReconcileNoticeProps): ReactNode {
  const outcomeUnknown = state.outcomeUnknown
  // A manual re-check is running: say so and don't allow a second one.
  const checking = state.checking === true
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
      data-testid="prompt-reconcile-notice"
      data-outcome-unknown={outcomeUnknown ? 'true' : undefined}
    >
      <AgentConnectionLamp connected={false} reconnecting decorative size={8} />
      <span>
        {checking
          ? 'Checking…'
          : outcomeUnknown
            ? 'Outcome unknown — check'
            : 'Waiting to confirm…'}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-5 px-1.5"
        onClick={onRecheck}
        disabled={checking}
        data-testid="prompt-reconcile-recheck"
      >
        {outcomeUnknown ? 'Re-check' : 'Check now'}
      </Button>
    </div>
  )
}
