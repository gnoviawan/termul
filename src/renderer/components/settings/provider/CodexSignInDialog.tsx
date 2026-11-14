import type { CodexAccountView } from '@shared/types/codex-accounts.types'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { CODEX_SIGN_IN_METHODS, signInCodexAccount } from '@/lib/codex-account-sign-in'

/**
 * Pick a ChatGPT sign-in method, then run it. The host sign-in dialog shows
 * the page or the device code while authenticate waits.
 */
export function CodexSignInDialog({
  account,
  onClose,
  onSignedIn
}: {
  account: CodexAccountView | null
  onClose: () => void
  onSignedIn: (account: CodexAccountView) => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = async (methodId: string): Promise<void> => {
    if (!account) return
    setBusy(methodId)
    setError(null)
    try {
      await signInCodexAccount(account.id, methodId)
      await onSignedIn(account)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      open={account !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {account ? `Sign in to ${account.name}` : 'Sign in'}
          </DialogTitle>
          <DialogDescription>
            Codex accounts use a ChatGPT login. Sign in with the browser, or use a device code on
            any other device.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter className="gap-2 sm:flex-col sm:items-stretch">
          {CODEX_SIGN_IN_METHODS.map((method) => (
            <Button
              key={method.id}
              type="button"
              variant={method.id === 'chat-gpt' ? 'default' : 'outline'}
              disabled={busy !== null}
              onClick={() => void start(method.id)}
            >
              {busy === method.id && <Spinner size={12} decorative />}
              {method.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
