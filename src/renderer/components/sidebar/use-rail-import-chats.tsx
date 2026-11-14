import { useCallback, useState } from 'react'
import { ImportChatsDialog } from '@/components/chat/ImportChatsDialog'
import { logRailEvent } from '@/components/shell/rail/rail-log'
import { useColumnWorkingCopy } from '@/components/shell/use-column-working-copy'
import type { Project } from '@/types/project'

interface RailImportChats {
  /** Opens the dialog; `undefined` when there is no open project or working copy. */
  onImportChats: (() => void) | undefined
  /** The Import chats dialog, to render once. */
  dialog: React.ReactNode
}

/**
 * Import chats from the Projects `+` menu: into the open project's working
 * copy (the worktree pick, else the project folder), with one durable log
 * line when it starts.
 */
export function useRailImportChats(projects: Project[], activeProjectId: string): RailImportChats {
  const [open, setOpen] = useState(false)
  const project = projects.find((p) => p.id === activeProjectId && !p.isArchived)
  const { cwd } = useColumnWorkingCopy(project)
  const start = useCallback((): void => {
    logRailEvent(`chat import started for project ${activeProjectId}`)
    setOpen(true)
  }, [activeProjectId])

  if (!project || cwd.trim().length === 0) return { onImportChats: undefined, dialog: null }
  return {
    onImportChats: start,
    dialog: (
      <ImportChatsDialog open={open} onOpenChange={setOpen} cwd={cwd} projectId={project.id} />
    )
  }
}
