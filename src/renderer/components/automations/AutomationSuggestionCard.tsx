import type { AutomationSuggestion } from '@shared/types/automation.types'
import { Workflow } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'

export function suggestionCopy(suggestion: AutomationSuggestion): string {
  return (
    `You've asked something like “${suggestion.representative}” on ${suggestion.days} days ` +
    `(usually ${suggestion.cadence.label}). Make it a background automation?`
  )
}

interface AutomationSuggestionCardProps {
  suggestion: AutomationSuggestion
  busy: boolean
  onCreate: () => void
  onLater: () => void
  onDismiss: () => void
}

/** A repeated ask and the three answers to it, in a chat or the Automations tab. */
export function AutomationSuggestionCard({
  suggestion,
  busy,
  onCreate,
  onLater,
  onDismiss
}: AutomationSuggestionCardProps): React.JSX.Element {
  const size = useMobileWebShell() ? 'touch' : 'sm'
  const titleId = `automation-suggestion-${suggestion.fingerprint}`
  return (
    <section
      aria-labelledby={titleId}
      className="rounded-2xl border border-border bg-card px-3.5 py-3 shadow-sm sm:px-4"
      data-testid="automation-suggestion-card"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
          <Workflow size={13} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-xs font-semibold leading-5 text-foreground">
            This looks repeatable
          </h2>
          <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">
            {suggestionCopy(suggestion)}
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button size={size} disabled={busy} onClick={onCreate}>
          Create automation
        </Button>
        <Button variant="outline" size={size} disabled={busy} onClick={onLater}>
          Not now
        </Button>
        <Button variant="ghost" size={size} disabled={busy} onClick={onDismiss}>
          Don't suggest this again
        </Button>
      </div>
    </section>
  )
}
