import { useCallback } from 'react'
import { toast } from 'sonner'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'

/**
 * Shows or hides the Side panel through the same persisted path as Ctrl+B
 * (`updatePanelVisibility('fileExplorerVisible', ...)`), with an error toast
 * when saving fails.
 */
export function useSidePanelToggle(): { visible: boolean; toggle: () => void } {
  const visible = useFileExplorerVisible()
  const updatePanelVisibility = useUpdatePanelVisibility()

  const toggle = useCallback(() => {
    void updatePanelVisibility('fileExplorerVisible', !visible).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to update side panel visibility')
    })
  }, [visible, updatePanelVisibility])

  return { visible, toggle }
}
