import { useEffect } from 'react'
import { toast } from 'sonner'
import { logFrontendError } from '@/lib/log-api'
import {
  dismissRenameNotice,
  isRenameNoticeDue,
  RENAME_NOTICE_DESCRIPTION,
  RENAME_NOTICE_DISMISS_LABEL,
  RENAME_NOTICE_TITLE
} from '@/lib/rename-notice'

const RENAME_NOTICE_TOAST_ID = 'rename-notice'

/**
 * Shows the rename notice once on a device that updated from the old name.
 * It stays until dismissed: the action or a swipe records it, while closing
 * the app first shows it again on the next launch.
 */
export function useRenameNotice(): void {
  useEffect(() => {
    if (!isRenameNoticeDue()) return
    // Defer the publish past this commit's effect flush (gh-1799): both
    // renderer roots mount <Toaster /> as a *later sibling* of the effects
    // host, so its sonner subscribe effect has not run yet when this one
    // fires. sonner drops a toast emitted while no Toaster is listening — it
    // never replays it — so emitting synchronously here shows nothing and the
    // dismiss is never recorded. A macrotask lands after the Toaster subscribes.
    const timer = setTimeout(() => {
      toast(RENAME_NOTICE_TITLE, {
        id: RENAME_NOTICE_TOAST_ID,
        description: RENAME_NOTICE_DESCRIPTION,
        duration: Number.POSITIVE_INFINITY,
        closeButton: false,
        action: { label: RENAME_NOTICE_DISMISS_LABEL, onClick: dismissRenameNotice },
        onDismiss: dismissRenameNotice
      })
      void logFrontendError({
        level: 'info',
        source: 'rename-notice',
        message: 'showed the rename notice on an updated device'
      })
    }, 0)
    return () => clearTimeout(timer)
  }, [])
}
