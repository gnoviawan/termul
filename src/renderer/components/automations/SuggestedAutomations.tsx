import { AutomationSuggestionCard } from './AutomationSuggestionCard'
import { isSnoozed, useSuggestionSnoozes } from './suggestion-snooze'
import { useAutomationSuggestions } from './use-automations'
import { useSuggestionActions } from './use-suggestion-actions'

/** Repeated asks offered as automations, above the project's automations. */
export function SuggestedAutomations({
  projectId
}: {
  projectId: string
}): React.JSX.Element | null {
  const suggestions = useAutomationSuggestions(projectId)
  const snoozes = useSuggestionSnoozes((s) => s.until)
  const actions = useSuggestionActions(projectId, () => suggestions.reload())
  const open = (suggestions.data ?? []).filter((s) => !isSnoozed(snoozes, projectId, s.fingerprint))
  if (open.length === 0) return null
  return (
    <section aria-label="Suggested" className="flex flex-col gap-2 p-2">
      <h3 className="px-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
        Suggested
      </h3>
      {open.map((suggestion) => (
        <AutomationSuggestionCard
          key={suggestion.fingerprint}
          suggestion={suggestion}
          busy={actions.busy}
          onCreate={() => void actions.create(suggestion)}
          onLater={() => actions.later(suggestion)}
          onDismiss={() => void actions.dismiss(suggestion)}
        />
      ))}
    </section>
  )
}
