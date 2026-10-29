import type { ClaudeAccountView } from '@shared/types/claude-accounts.types'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { LinkSignInStep } from './LinkSignInStep'

interface LinkSignInDialogProps {
  /** The Account to sign in. `null` closes the dialog. */
  account: ClaudeAccountView | null
  onClose: () => void
  onSignedIn: (account: ClaudeAccountView) => void
}

/** The link sign-in of an Account that is already in the list. */
export function LinkSignInDialog({
  account,
  onClose,
  onSignedIn
}: LinkSignInDialogProps): React.JSX.Element {
  return (
    <Dialog open={account !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-5 sm:max-w-[400px]">
        {account && (
          <LinkSignInStep
            account={account}
            onCancel={onClose}
            onSignedIn={() => onSignedIn(account)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
