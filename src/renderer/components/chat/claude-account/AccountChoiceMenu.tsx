import { ExternalLink } from '@/components/icons'
import { StatusDot, UsageBar } from '@/components/settings/provider/account-status'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { MENU_ACTIVE_ROW_CLASS } from '@/components/ui/menu-styles'
import { type UsageTone, usageTone } from '@/lib/claude-usage-format'
import { cn } from '@/lib/utils'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { choiceDotTone, choicePercent } from './account-choice'
import type { AccountChoice } from './use-project-claude-account'

const PERCENT_TONE: Record<UsageTone, string> = {
  normal: 'text-muted-foreground',
  warning: 'text-warning',
  critical: 'text-destructive'
}

interface AccountChoiceMenuProps {
  /** Accounts with room, best first. */
  choices: AccountChoice[]
  /** The chosen row: filled, never ticked. */
  selectedId?: string | null
  onSelect: (choice: AccountChoice) => void
  /** The Account at its limit, listed last and disabled. */
  exhausted?: { name: string; note: string } | null
  /** The trigger button (rendered with `asChild`). */
  children: React.ReactElement
}

/**
 * Account picker for the usage-limit dock: each Account with its dot, usage
 * bar and percent in fixed lanes, so a long list stays one compact column.
 */
export function AccountChoiceMenu({
  choices,
  selectedId = null,
  onSelect,
  exhausted = null,
  children
}: AccountChoiceMenuProps): React.JSX.Element {
  const openAppSettings = useSettingsModalStore((s) => s.openApp)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={4} className="min-w-72">
        <DropdownMenuLabel>Account for this project</DropdownMenuLabel>
        {choices.map((choice) => {
          const percent = choicePercent(choice)
          const tone = usageTone(choice.window?.percent ?? 0)
          return (
            <DropdownMenuItem
              key={choice.account.id}
              onSelect={() => onSelect(choice)}
              className={cn(
                'gap-2.5',
                choice.account.id === selectedId && cn(MENU_ACTIVE_ROW_CLASS, 'text-foreground')
              )}
            >
              <StatusDot tone={choiceDotTone(choice)} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  choice.account.id === selectedId ? 'font-medium' : 'text-secondary-foreground'
                )}
              >
                {choice.account.name}
              </span>
              <span className="w-10 shrink-0">
                {choice.window && (
                  <UsageBar
                    window={choice.window}
                    label={`${choice.account.name} usage`}
                    valueText={`${percent}% used`}
                  />
                )}
              </span>
              <span className={cn('w-16 shrink-0 text-right tabular-nums', PERCENT_TONE[tone])}>
                {percent === null ? '' : `${percent}% used`}
              </span>
            </DropdownMenuItem>
          )
        })}
        {exhausted && (
          <DropdownMenuItem disabled className="gap-2.5">
            <StatusDot tone="critical" />
            <span className="min-w-0 flex-1 truncate">{exhausted.name}</span>
            <span className="shrink-0 text-right">{exhausted.note}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openAppSettings('provider')} className="gap-2">
          <span className="flex-1">Manage accounts</span>
          <ExternalLink size={12} className="text-muted-foreground" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Raised trigger for the menu, sitting on the composer card. */
export const ACCOUNT_MENU_TRIGGER_CLASS =
  'inline-flex h-7 shrink-0 items-center gap-2 rounded-lg border-[0.5px] border-border bg-muted pl-2.5 pr-2 text-xs shadow-xs transition-colors hover:bg-foreground/[0.08] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring data-[state=open]:bg-foreground/[0.08] [&[data-state=open]_svg]:rotate-180'
