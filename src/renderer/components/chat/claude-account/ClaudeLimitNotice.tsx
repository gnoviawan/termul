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
import { ACCOUNT_MENU_TRIGGER_CLASS, AccountChoiceMenu } from './AccountChoiceMenu'
import { choiceDotTone, choicePercent } from './account-choice'
import {
  formatClock,
  isAtLimit,
  useClaudeLimit,
  useClaudeResumeStore,
  windowName
} from './use-claude-limit'
import type { AccountChoice } from './use-project-claude-account'

const sentence = (text: string): string => `${text[0].toUpperCase()}${text.slice(1)}.`

/** The Account picker and "Switch and continue". */
function ChosenAccountActions({
  choices,
  chosen,
  onChoose,
  exhaustedName,
  reset,
  onSwitch
}: {
  choices: AccountChoice[]
  chosen: AccountChoice
  onChoose: (choice: AccountChoice) => void
  exhaustedName: string
  reset: string | null
  onSwitch: () => void
}): React.JSX.Element {
  const chosenPercent = choicePercent(chosen)
  return (
    <>
      <span className="text-xs text-muted-foreground">Go on with</span>
      <AccountChoiceMenu
        choices={choices}
        selectedId={chosen.account.id}
        onSelect={onChoose}
        exhausted={{
          name: exhaustedName,
          note: reset ? sentence(reset).slice(0, -1) : 'Resets soon'
        }}
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
        <Button type="button" size="xs" className="px-3" onClick={onSwitch}>
          Switch and continue
        </Button>
      </ComposerDockActions>
    </>
  )
}

/** "Continues at 14:05 · Cancel" while a resume is scheduled. */
function ScheduledResume({ sessionId, at }: { sessionId: string; at: number }): React.JSX.Element {
  const cancelResume = useClaudeResumeStore((s) => s.cancel)
  return (
    <span className="flex items-center gap-2 text-xs text-secondary-foreground">
      <Clock size={12} />
      Continues at {formatClock(at)}
      <button
        type="button"
        onClick={() => cancelResume(sessionId)}
        className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-focus-ring"
      >
        Cancel
      </button>
    </span>
  )
}

/** No Account has room: add one, or continue when the window resets. */
function NoRoomActions({
  sessionId,
  resetsAt
}: {
  sessionId: string
  /** Window reset, in seconds since the epoch, or null when unknown. */
  resetsAt: number | null
}): React.JSX.Element {
  const openAppSettings = useSettingsModalStore((s) => s.openApp)
  const schedule = useClaudeResumeStore((s) => s.schedule)
  const canAddAccount = useServerAdmitsRemoteWrites()
  return (
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
      {resetsAt !== null && (
        <Button
          type="button"
          size="xs"
          className="px-3"
          onClick={() => schedule(sessionId, resetsAt * 1000)}
        >
          <Clock />
          Continue when it resets
        </Button>
      )}
    </ComposerDockActions>
  )
}

/**
 * Composer dock for a Claude chat at its Account's limit: pick the Account to
 * go on with (the one with the most room is chosen), then switch and
 * continue. With no room anywhere, continue when the window resets.
 * The near-limit warning is `ClaudeLimitWarning`.
 */
export function ClaudeLimitNotice({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const state = useClaudeLimit(sessionId)
  const scheduledAt = useClaudeResumeStore((s) => s.at[sessionId] ?? null)
  const [chosenId, setChosenId] = useState<string | null>(null)
  if (!state || !isAtLimit(state.limit)) return null

  const { ctx, limit, name, reset, switchTo, switchingTo: switching } = state
  const choices = ctx.alternatives
  const chosen = choices.find((c) => c.account.id === chosenId) ?? choices[0] ?? null

  let nextStep: React.ReactNode
  if (switching) {
    nextStep = (
      <span className="flex items-center gap-2 text-xs text-secondary-foreground">
        <Spinner size={12} decorative />
        Switching to {switching} and continuing…
      </span>
    )
  } else if (chosen) {
    nextStep = (
      <ChosenAccountActions
        choices={choices}
        chosen={chosen}
        onChoose={(choice) => setChosenId(choice.account.id)}
        exhaustedName={name}
        reset={reset}
        onSwitch={() => void switchTo(chosen)}
      />
    )
  } else if (scheduledAt) {
    nextStep = <ScheduledResume sessionId={sessionId} at={scheduledAt} />
  } else {
    nextStep = <NoRoomActions sessionId={sessionId} resetsAt={limit.resetsAt} />
  }

  return (
    <ComposerDock tone="warning" role="alert" data-testid="claude-limit-notice">
      <ComposerDockRow>
        <ComposerDockMessage title={`${name} reached its ${windowName(limit)} limit.`}>
          {reset ? sentence(reset) : 'It resets soon.'}{' '}
          {chosen ? 'Your draft is kept.' : 'No other account has room left right now.'}
        </ComposerDockMessage>
      </ComposerDockRow>
      <ComposerDockRow className="pl-[17px]">{nextStep}</ComposerDockRow>
    </ComposerDock>
  )
}
