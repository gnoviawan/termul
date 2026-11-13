import { Button } from '@/components/ui/button'
import {
  COMPOSER_DOCK_TEXT_ACTION_CLASS,
  ComposerDock,
  ComposerDockActions,
  ComposerDockMessage,
  ComposerDockRow
} from './composer/ComposerDock'

interface ChatStoppedNoticeProps {
  /** Why the chat stopped (a failed resume, a signed-out CLI), or null. */
  reason: string | null
  /** Primary action label: "Resume chat", or "Sign in" for a signed-out CLI. */
  actionLabel: string
  onAction: () => void
  /** Opens a new chat in the same pane; omitted where that is not possible. */
  onNewChat?: () => void
  /** Extra action before the primary one (Claude sign-in). */
  extraAction?: React.ReactNode
}

/**
 * A stopped chat, docked at the top of the composer card. One message and one
 * next step replace the old stop bar, the resume-error banner and the
 * "Session closed" pill.
 */
export function ChatStoppedNotice({
  reason,
  actionLabel,
  onAction,
  onNewChat,
  extraAction
}: ChatStoppedNoticeProps): React.JSX.Element {
  return (
    <ComposerDock tone="warning" role="status" data-testid="chat-stopped-notice">
      <ComposerDockRow>
        <ComposerDockMessage title="This chat stopped.">
          {reason ?? 'Resume it to go on where it left off.'}
        </ComposerDockMessage>
        <ComposerDockActions>
          {onNewChat && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={onNewChat}
              className={COMPOSER_DOCK_TEXT_ACTION_CLASS}
            >
              New chat
            </Button>
          )}
          {extraAction}
          <Button type="button" size="xs" onClick={onAction} className="px-3">
            {actionLabel}
          </Button>
        </ComposerDockActions>
      </ComposerDockRow>
    </ComposerDock>
  )
}
