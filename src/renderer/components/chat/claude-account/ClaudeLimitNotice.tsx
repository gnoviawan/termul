import { useState } from 'react'
import { ChevronDown, Clock } from '@/components/icons'
import { StatusDot } from '@/components/settings/provider/account-status'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import {
  COMPOSER_DOCK_TEXT_ACTION_CLASS,
  ComposerDock,
  ComposerDockActions,
  ComposerDockMessage,
  ComposerDockRow
} from '../composer/ComposerDock'
import {
  ACCOUNT_MENU_TRIGGER_CLASS,
  AccountChoiceMenu,
  choiceDotTone,
  choicePercent
} from './AccountChoiceMenu'
import {
  formatClock,
  isAtLimit,
  useClaudeLimit,
  useClaudeResumeStore,
  windowName
} from './use-claude-limit'

const sentence = (text: string): string => `${text[0].toUpperCase()}${text.slice(1)}.`

/**
 * Composer dock for a Claude chat at its Account's limit: pick the Account to
 * go on with (the one with the most room is chosen), then switch and
 * continue. With no room anywhere, continue when the window resets.
 * The near-limit warning is `ClaudeLimitWarning`.
 */
export function ClaudeLimitNotice({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const state = useClaudeLimit(sessionId)
  const openAppSettings = useSettingsModalStore((s) => s.openApp)
  const scheduledAt = useClaudeResumeStore((s) => s.at[sessionId] ?? null)
  const schedule = useClaudeResumeStore((s) => s.schedule)
  const cancelResume = useClaudeResumeStore((s) => s.cancel)
  const canAddAccount = useServerAdmitsRemoteWrites()
  const [chosenId, setChosenId] = useState<string | null>(null)
  if (!state || !isAtLimit(state.limit)) return null

  const { ctx, limit, name, reset, switchTo, switchingTo: switching } = state
  const choices = ctx.alternatives
  const chosen = choices.find((c) => c.account.id === chosenId) ?? choices[0] ?? null
  const chosenPercent = chosen ? choicePercent(chosen) : null

  return (
    <ComposerDock tone="warning" role="alert" data-testid="claude-limit-notice">
      <ComposerDockRow>
        <ComposerDockMessage title={`${name} reached its ${windowName(limit)} limit.`}>
          {reset ? sentence(reset) : 'It resets soon.'}{' '}
          {chosen ? 'Your draft is kept.' : 'No other account has room left right now.'}
        </ComposerDockMessage>
      </ComposerDockRow>

      <ComposerDockRow className="pl-[17px]">
        {switching ? (
          <span className="flex items-center gap-2 text-xs text-secondary-foreground">
            <Spinner size={12} decorative />
            Switching to {switching} and continuing…
          </span>
        ) : chosen ? (
          <>
            <span className="text-xs text-muted-foreground">Go on with</span>
            <AccountChoiceMenu
              choices={choices}
              selectedId={chosen.account.id}
              onSelect={(choice) => setChosenId(choice.account.id)}
              exhausted={{ name, note: reset ? sentence(reset).slice(0, -1) : 'Resets soon' }}
            >
              <button
                type="button"
                className={ACCOUNT_MENU_TRIGGER_CLASS}
                aria-label={`Account to go on with: ${chosen.account.name}${chosenPercent === null ? '' : `, ${chosenPercent}% used`}. Change account`}
              >
                <StatusDot tone={choiceDotTone(chosen)} />
                <span className="max-w-32 truncate font-medium text-foreground">
                  {chosen.account.name}
                </span>
                {chosenPercent !== null && (
                  <span className="tabular-nums text-muted-foreground">{chosenPercent}% used</span>
                )}
                <ChevronDown
                  size={12}
                  className="text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none"
                />
              </button>
            </AccountChoiceMenu>
            <ComposerDockActions>
              <Button
                type="button"
                size="xs"
                className="px-3"
                onClick={() => void switchTo(chosen)}
              >
                Switch and continue
              </Button>
            </ComposerDockActions>
          </>
        ) : scheduledAt ? (
          <span className="flex items-center gap-2 text-xs text-secondary-foreground">
            <Clock size={12} />
            Continues at {formatClock(scheduledAt)}
            <button
              type="button"
              onClick={() => cancelResume(sessionId)}
              className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-focus-ring"
            >
              Cancel
            </button>
          </span>
        ) : (
          <ComposerDockActions className="ml-0">
            {canAddAccount && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => openAppSettings('provider')}
                className={COMPOSER_DOCK_TEXT_ACTION_CLASS}
              >
                Add account
              </Button>
            )}
            {limit.resetsAt !== null && (
              <Button
                type="button"
                size="xs"
                className="px-3"
                onClick={() => schedule(sessionId, (limit.resetsAt ?? 0) * 1000)}
              >
                <Clock />
                Continue when it resets
              </Button>
            )}
          </ComposerDockActions>
        )}
      </ComposerDockRow>
    </ComposerDock>
  )
}
