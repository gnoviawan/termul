import { CHAT_GUTTER_X } from '@/components/chat/chat-layout'
import { AutomationSuggestionCard } from './AutomationSuggestionCard'
import { useChatAutomationSuggestion } from './use-chat-automation-suggestion'

/** The suggestion card a chat shows above its composer after a repeated ask. */
export function ChatAutomationSuggestion({
  sessionId,
  projectId
}: {
  sessionId: string
  projectId: string | undefined
}): React.JSX.Element | null {
  const offer = useChatAutomationSuggestion(sessionId, projectId)
  if (!offer) return null
  const { suggestion } = offer
  return (
    <div className={`${CHAT_GUTTER_X} pb-2 pt-3`}>
      <div className="mx-auto w-full max-w-3xl">
        <AutomationSuggestionCard
          suggestion={suggestion}
          busy={offer.busy}
          onCreate={() => void offer.create(suggestion)}
          onLater={() => offer.later(suggestion)}
          onDismiss={() => void offer.dismiss(suggestion)}
        />
      </div>
    </div>
  )
}
