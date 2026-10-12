import type { ReactNode } from 'react'
import { AgentConnectionLamp } from './AgentConnectionLamp'

/**
 * AD-6 pending-reconcile state: the connection dropped before the host
 * confirmed the prompt, and the app is resending the same turn. Not an error —
 * the message stays in the transcript and the composer stays busy until the
 * host answers. Non-blocking; announces itself politely.
 */
export function PromptReconcileNotice(): ReactNode {
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
      data-testid="prompt-reconcile-notice"
    >
      <AgentConnectionLamp connected={false} reconnecting decorative size={8} />
      <span>Waiting to confirm…</span>
    </div>
  )
}
