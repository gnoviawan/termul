import type { AutomationSuggestion } from '@shared/types/automation.types'
import { useState } from 'react'
import { toast } from 'sonner'
import { acceptAutomationSuggestion, dismissAutomationSuggestion } from '@/lib/automation-api'
import { launchSuggestionChat } from '@/lib/automation-suggestion-launch'
import { logFrontendError } from '@/lib/log-api'
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

  // Accepted only once the prompt reached a chat or the launcher: a launch
  // that fails leaves the suggestion open to try again.
  const create = async (suggestion: AutomationSuggestion): Promise<void> => {
    setBusy(true)
    if (!(await launchSuggestionChat(projectId, suggestion))) {
      setBusy(false)
      return
    }
    const accepted = await acceptAutomationSuggestion(projectId, suggestion.fingerprint)
    setBusy(false)
    if (!accepted.success) {
      void logFrontendError({
        level: 'warn',
        source: 'automations.suggestions',
        message: `suggestion=${suggestion.fingerprint} launched but not recorded: ${accepted.error}`
      })
    }
    onAnswered(suggestion)
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
