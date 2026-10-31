import type { AutomationSuggestion } from '@shared/types/automation.types'
import { useState } from 'react'
import { toast } from 'sonner'
import { acceptAutomationSuggestion, dismissAutomationSuggestion } from '@/lib/automation-api'
import { launchSuggestionChat } from '@/lib/automation-suggestion-launch'
import { useSuggestionSnoozes } from './suggestion-snooze'

export interface SuggestionActions {
  busy: boolean
  create: (suggestion: AutomationSuggestion) => Promise<void>
  later: (suggestion: AutomationSuggestion) => void
  dismiss: (suggestion: AutomationSuggestion) => Promise<void>
}

/**
 * The three answers to a suggestion. `onAnswered` runs once the answer took
 * effect, so the caller can hide it.
 */
export function useSuggestionActions(
  projectId: string,
  onAnswered: (suggestion: AutomationSuggestion) => void
): SuggestionActions {
  const [busy, setBusy] = useState(false)
  const snooze = useSuggestionSnoozes((s) => s.snooze)

  const create = async (suggestion: AutomationSuggestion): Promise<void> => {
    setBusy(true)
    const accepted = await acceptAutomationSuggestion(projectId, suggestion.fingerprint)
    setBusy(false)
    if (!accepted.success) {
      toast.error(`Could not create the automation: ${accepted.error}`)
      return
    }
    onAnswered(suggestion)
    await launchSuggestionChat(projectId, suggestion)
  }

  const later = (suggestion: AutomationSuggestion): void => {
    snooze(suggestion.fingerprint)
    onAnswered(suggestion)
  }

  const dismiss = async (suggestion: AutomationSuggestion): Promise<void> => {
    setBusy(true)
    const dismissed = await dismissAutomationSuggestion(projectId, suggestion.fingerprint)
    setBusy(false)
    if (!dismissed.success) {
      toast.error(`Could not dismiss the suggestion: ${dismissed.error}`)
      return
    }
    onAnswered(suggestion)
  }

  return { busy, create, later, dismiss }
}
