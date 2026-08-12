import type { CustomRendererProps } from 'streamdown'

import type { PlanEntry } from '@/lib/acp-api'

import { PlanPanel } from './PlanPanel'

/**
 * Streamdown custom renderer for `termul-plan` fenced code blocks. Parses the
 * fence JSON and renders a read-only `PlanPanel` so historical assistant
 * messages retain their plan-of-record inline in the transcript.
 *
 * The live sticky plan covers the streaming turn; this renderer is gated to
 * non-streaming (historical) messages via the `STREAMDOWN_PLUGINS` selection
 * in `ChatMessage` — the `termul-plan` renderer is only attached when
 * `!streaming` so an in-flight turn never shows a duplicate inline plan.
 *
 * Malformed JSON degrades to a "Plan snapshot unavailable" fallback card so a
 * corrupted snapshot never crashes the transcript; the store's rehydrate path
 * independently logs the malformed fence and leaves `plans[sessionId]` empty.
 */
export function TermulPlanRenderer({ code, isIncomplete }: CustomRendererProps): React.JSX.Element {
  // An incomplete fence (closing ``` not yet arrived) can't be parsed. This
  // renderer is gated to non-streaming messages, but `isIncomplete` is a
  // defensive backstop for a truncated historical payload.
  if (isIncomplete) {
    return (
      <div
        role="status"
        className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground/70"
      >
        Plan snapshot streaming…
      </div>
    )
  }

  let parsed: PlanEntry[] | null = null
  try {
    const value: unknown = JSON.parse(code)
    if (Array.isArray(value)) {
      parsed = value.filter(
        (entry): entry is PlanEntry =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as PlanEntry).content === 'string'
      )
      if (parsed.length === 0) parsed = null
    }
  } catch {
    parsed = null
  }

  if (parsed === null) {
    return (
      <div
        role="alert"
        className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      >
        Plan snapshot unavailable
      </div>
    )
  }

  return <PlanPanel entries={parsed} />
}
