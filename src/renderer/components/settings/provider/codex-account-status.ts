import type { CodexAccountView } from '@shared/types/codex-accounts.types'

/** Whether Codex chats can start on an Account: only a confirmed login passes. */
export type CodexAccountReadiness = 'ready' | 'signed-out' | 'unconfirmed'

export function codexAccountReadiness(account: CodexAccountView): CodexAccountReadiness {
  if (account.signedIn === false) return 'signed-out'
  return account.signedIn === true ? 'ready' : 'unconfirmed'
}

export const CODEX_NOT_READY_REASON: Record<Exclude<CodexAccountReadiness, 'ready'>, string> = {
  'signed-out': 'Signed out',
  unconfirmed: 'Could not check sign-in'
}
