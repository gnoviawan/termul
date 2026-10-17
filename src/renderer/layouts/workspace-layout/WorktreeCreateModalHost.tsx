import { useEffect, useState } from 'react'
import { NewWorktreeModal } from '@/components/NewWorktreeModal'
import { WORKTREE_EVENTS } from '@/hooks/use-worktree-shortcuts'

/**
 * Opens `NewWorktreeModal` when the Create Worktree shortcut fires.
 *
 * The shortcut dispatches `WORKTREE_EVENTS.OPEN_CREATE_MODAL` with the active
 * project id. This host is always mounted with the workspace modals, so the
 * shortcut works whether the Rail is expanded or collapsed (the sidebar that
 * also renders this modal is only mounted while the Rail is expanded).
 */
export function WorktreeCreateModalHost(): React.JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(null)

  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail
      if (detail?.projectId) setProjectId(detail.projectId)
    }
    window.addEventListener(WORKTREE_EVENTS.OPEN_CREATE_MODAL, onOpen)
    return () => window.removeEventListener(WORKTREE_EVENTS.OPEN_CREATE_MODAL, onOpen)
  }, [])

  return (
    <NewWorktreeModal
      isOpen={projectId !== null}
      onClose={() => setProjectId(null)}
      projectId={projectId ?? ''}
    />
  )
}
