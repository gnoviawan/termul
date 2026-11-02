import { useEffect } from 'react'
import { accountReadiness, NOT_READY_REASON } from '@/components/settings/provider/account-status'
import { useAcpStore } from '@/stores/acp-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { useChatClaudeAccount } from './use-chat-claude-account'

/**
 * The way out of a stopped Claude chat whose Account is not signed in: the
 * reason and a button to the Accounts page, where the user signs in (desktop)
 * or reads how to sign in on the host (web). Renders nothing otherwise.
 */
export function ClaudeSignInAction({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const ctx = useChatClaudeAccount(sessionId)
  const openAppSettings = useSettingsModalStore((s) => s.openApp)
  const lastError = useAcpStore((s) => s.sessions[sessionId]?.lastError ?? null)
  const reload = ctx?.accounts.reload
  // The Account may have signed out after this chat read the list; read it
  // again whenever the chat records a new failure.
  useEffect(() => {
    if (lastError) void reload?.()
  }, [lastError, reload])
  if (!ctx) return null
  const readiness = accountReadiness(ctx.current.account, ctx.current.usage)
  if (readiness === 'ready') return null
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">
        {ctx.current.account.name}: {NOT_READY_REASON[readiness].toLowerCase()}
      </span>
      <button
        type="button"
        onClick={() => openAppSettings('provider')}
        className="inline-flex min-h-11 shrink-0 items-center rounded-md border border-warning/40 px-3 text-xs font-medium transition-colors hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 @[400px]:min-h-10"
      >
        Open Accounts
      </button>
    </span>
  )
}
