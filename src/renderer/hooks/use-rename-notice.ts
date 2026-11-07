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
  }, [])
}
