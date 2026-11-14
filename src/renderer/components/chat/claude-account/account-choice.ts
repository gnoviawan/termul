import type { AccountTone } from '@/components/settings/provider/account-status'
import { type UsageTone, usageTone } from '@/lib/claude-usage-format'
import type { AccountChoice } from './use-project-claude-account'

const DOT_TONE: Record<UsageTone, AccountTone> = {
  normal: 'ok',
  warning: 'warning',
  critical: 'critical'
}

/** Dot tone for an Account choice, from its most-used window. */
export const choiceDotTone = (choice: AccountChoice): AccountTone =>
  DOT_TONE[usageTone(choice.window?.percent ?? 0)]

/** Rounded percent used of an Account choice's most-used window, or null. */
export const choicePercent = (choice: AccountChoice): number | null =>
  choice.window ? Math.round(choice.window.percent) : null
