import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useWorkspaceStore } from '@/stores/workspace-store'

/**
 * Opens the agent launcher in the active pane. The launcher overlay only
 * renders on the workspace route, so a child route goes back to `/` first
 * and the launcher opens on the next frame. Shared by the Rail's New chat
 * row and the Side panel's New chat button.
 */
export function useNewChat(): () => void {
  const pathname = useLocation().pathname
  const navigate = useNavigate()

  return useCallback(() => {
    const open = (): void => {
      const paneId = useWorkspaceStore.getState().activePaneId
      if (paneId) useWorkspaceStore.getState().showAgentLauncher(paneId)
    }
    if (pathname !== '/') {
      navigate('/')
      requestAnimationFrame(open)
    } else {
      open()
    }
  }, [navigate, pathname])
}
