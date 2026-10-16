import { ConfirmDialog } from '@/components/ConfirmDialog'
import { type ProjectBusyRequest, useProjectBusyStore } from '@/stores/project-busy-store'

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** "2 chats and 1 terminal", "1 chat", ... — only the kinds that are actually bound. */
export function describeBoundEntities(sessions: number, terminals: number): string {
  const parts = [
    ...(sessions > 0 ? [plural(sessions, 'chat')] : []),
    ...(terminals > 0 ? [plural(terminals, 'terminal')] : [])
  ]
  return parts.join(' and ')
}

function copyFor(request: ProjectBusyRequest): { title: string; message: string; confirm: string } {
  const bound = describeBoundEntities(request.sessions, request.terminals)
  const still =
    bound === ''
      ? 'Chats or terminals are'
      : `${bound} ${request.sessions + request.terminals === 1 ? 'is' : 'are'}`
  if (request.kind === 'delete') {
    return {
      title: `Delete "${request.projectName}"?`,
      message: `${still} still running in this project. Deleting it stops everything that is running there first. This cannot be undone.`,
      confirm: 'Stop and delete'
    }
  }
  if (request.kind === 'archive') {
    return {
      title: `Archive "${request.projectName}"?`,
      message: `${still} still running in this project. Archiving it stops everything that is running there first.`,
      confirm: 'Stop and archive'
    }
  }
  return {
    title: `Change the folder of "${request.projectName}"?`,
    message: `${still} still running in this project. Changing its folder stops everything that is running there first.`,
    confirm: 'Stop and change folder'
  }
}

/**
 * Asks before the host stops a project's live chats and terminals. A delete or
 * archive the host refused as busy lands in the busy store; only Confirm resends
 * it with `cascade: true`. Cancel leaves the project and everything in it alone.
 */
export function ProjectBusyDialog(): React.JSX.Element {
  const request = useProjectBusyStore((state) => state.requests[0])
  const isResending = useProjectBusyStore((state) => state.isResending)
  const copy = request ? copyFor(request) : null

  return (
    <ConfirmDialog
      isOpen={request !== undefined}
      title={copy?.title ?? ''}
      message={copy?.message ?? ''}
      confirmLabel={copy?.confirm ?? 'Confirm'}
      cancelLabel="Keep project"
      variant="danger"
      isLoading={isResending}
      onConfirm={() => void useProjectBusyStore.getState().confirm()}
      onCancel={() => useProjectBusyStore.getState().dismiss()}
    />
  )
}
