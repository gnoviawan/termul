import { toast } from 'sonner'
import { unableTo } from '@/lib/recovery-copy'
import { useWorkspaceStore } from '@/stores/workspace-store'

/** Opens the agent launcher in the active pane, the same action as New chat. */
export function startNewChat(): void {
  const paneId = useWorkspaceStore.getState().activePaneId
  if (!paneId) {
    toast.error(unableTo('start a chat', 'Open a workspace pane'))
    return
  }
  useWorkspaceStore.getState().showAgentLauncher(paneId)
}
