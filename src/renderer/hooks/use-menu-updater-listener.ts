import { useEffect } from 'react'
import { useUpdaterActions } from '@/stores/updater-store'

/**
 * useMenuUpdaterListener Hook
 *
 * Placeholder hook for compatibility. In current architecture,
 * updater checks are triggered by updater initialization and UI actions.
 */
export function useMenuUpdaterListener(): void {
  const { initializeUpdater } = useUpdaterActions()

  useEffect(() => {
    void initializeUpdater({ autoCheck: false })
  }, [initializeUpdater])
}
