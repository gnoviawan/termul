import { ChevronDown, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  ComposerDock,
  ComposerDockActions,
  ComposerDockMessage,
  ComposerDockRow
} from '../composer/ComposerDock'
import { ACCOUNT_MENU_TRIGGER_CLASS, AccountChoiceMenu } from './AccountChoiceMenu'
import { isNearLimit, useClaudeLimit, windowName } from './use-claude-limit'

/**
 * Composer dock for a Claude chat near its Account's limit (from 80%). Only a
 * warning: the composer stays usable, so there is no primary action, only the
 * Account switch and a dismiss.
 */
export function ClaudeLimitWarning({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const state = useClaudeLimit(sessionId)
  if (!state || !isNearLimit(state.limit)) return null

  const { limit, name, reset, switchTo, dismiss } = state
  const choices = state.ctx.alternatives
  return (
    <ComposerDock tone="warning" role="status" data-testid="claude-limit-warning">
      <ComposerDockRow>
        <ComposerDockMessage
          title={`${name} has used ${Math.round(limit.percent ?? 80)}% of its ${windowName(limit)} limit.`}
        >
          {reset ? `${reset[0].toUpperCase()}${reset.slice(1)}.` : null}
        </ComposerDockMessage>
        <ComposerDockActions>
          {choices.length > 0 && (
            <AccountChoiceMenu choices={choices} onSelect={(choice) => void switchTo(choice)}>
              <button type="button" className={ACCOUNT_MENU_TRIGGER_CLASS}>
                <span className="font-medium text-foreground">Switch account</span>
                <ChevronDown
                  size={12}
                  className="text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none"
                />
              </button>
            </AccountChoiceMenu>
          )}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={dismiss}
            aria-label="Dismiss"
            className="text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground [&_svg]:size-3"
          >
            <X />
          </Button>
        </ComposerDockActions>
      </ComposerDockRow>
    </ComposerDock>
  )
}
