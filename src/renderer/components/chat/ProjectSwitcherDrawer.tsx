import { Check, FolderGit2, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { getAcpTransport } from '@/lib/acp-transport'
import { getColorClasses } from '@/lib/colors'
import { setTabFocusedSessionId } from '@/lib/web-tab-session'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'

interface ProjectSwitcherDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Web/remote project switcher (Epic-4 bridge). Mirrors the desktop's available
 * project list (read-only, fetched into the project store by `useProjectsLoader`
 * via `GET /projects`) and switches the shared-live session to a project's cwd
 * via the `switch_project` WS request. Archived projects render greyed + are
 * not clickable. The currently active project is marked. The Tauri desktop
 * transport has no `switchProject` — this drawer is mounted only in web/remote
 * mode, so a missing method is a no-op (defensive).
 */
export function ProjectSwitcherDrawer({
  open,
  onOpenChange
}: ProjectSwitcherDrawerProps): React.JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const selectProject = useProjectStore((s) => s.selectProject)
  const [switchingId, setSwitchingId] = useState<string | null>(null)

  async function handleSwitch(project: Project): Promise<void> {
    const transport = getAcpTransport()
    // Desktop transport has no `switchProject`; the drawer is web-only, so this
    // is defensive — never crash if mounted outside web mode.
    if (!transport.switchProject) return
    if (switchingId !== null) return
    setSwitchingId(project.id)
    try {
      const { sessionId } = await transport.switchProject(project.id)
      setTabFocusedSessionId(sessionId)
      selectProject(project.id)
      onOpenChange(false)
    } catch (err) {
      // `AcpTransportError.message` is the human string callers already toast
      // (e.g. "no_agent" → "switch_project requires a live agent; …").
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSwitchingId(null)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="flex w-[min(100vw-3rem,20rem)] flex-col gap-0 p-0 sm:max-w-sm"
      >
        <SheetHeader className="space-y-0 border-b border-border/60 px-4 py-3 text-left">
          <div className="flex items-center gap-2 pr-8">
            <FolderGit2 size={20} />
            <SheetTitle className="text-base">Projects</SheetTitle>
          </div>
          <SheetDescription className="sr-only">
            Switch the shared session to a desktop project
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {projects.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              No projects available. Add a project on the desktop.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {projects.map((project) => {
                const isArchived = project.isArchived ?? false
                const isActive = project.id === activeProjectId
                const isSwitching = switchingId === project.id
                const disabled = isArchived || isActive || switchingId !== null
                return (
                  <li key={project.id}>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => void handleSwitch(project)}
                      className={[
                        'flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition-colors',
                        isActive ? 'bg-primary/20' : 'hover:bg-sidebar-accent/50',
                        isArchived ? 'opacity-50' : '',
                        disabled ? 'cursor-not-allowed' : 'cursor-pointer'
                      ].join(' ')}
                    >
                      <span
                        aria-hidden="true"
                        className={[
                          'size-2.5 shrink-0 rounded-full',
                          getColorClasses(project.color).bg
                        ].join(' ')}
                      />
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {project.name}
                      </span>
                      {isSwitching ? (
                        <Loader2
                          size={14}
                          className="shrink-0 animate-spin text-muted-foreground"
                        />
                      ) : isActive ? (
                        <Check size={14} className="shrink-0 text-primary" />
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
