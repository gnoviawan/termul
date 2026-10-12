import { useState } from 'react'
import { toast } from 'sonner'
import { Check, FolderGit2, Home, Plus, Settings } from '@/components/icons'
import { ProjectIcon } from '@/components/ProjectIcon'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useProjectSwitch } from '@/hooks/use-project-switch'
import { setHostDefaultProject } from '@/lib/tauri-remote-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { webServerProjects } from '@/lib/web-server-api'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'

interface ProjectSwitcherDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Opens the existing New project flow. Omitted when that action is not available. */
  onAddProject?: () => void
  /** Opens Project settings for the active project. Omitted when that action is not available. */
  onOpenProjectSettings?: () => void
  /** Edge the sheet opens from. `left` (default) is the desktop-style side drawer. */
  side?: 'left' | 'bottom'
  /** DOM id for the sheet content, so a trigger can point `aria-controls` at it. */
  id?: string
  /** Radix close auto-focus hook; the opener is a plain Button, so the owner returns focus. */
  onCloseAutoFocus?: (event: Event) => void
}

const SIDE_CLASS_NAME = {
  left: 'flex w-[72vw] max-w-20rem flex-col gap-0 p-0 sm:max-w-sm',
  bottom:
    'flex max-h-[85dvh] flex-col gap-0 overflow-y-auto overscroll-contain p-0 pb-[max(0.5rem,env(safe-area-inset-bottom))]'
} as const

/**
 * Web/remote project switcher (Epic-4 bridge). Mirrors the desktop's available
 * project list (read-only, fetched into the project store by `useProjectsLoader`
 * via `GET /projects`) and makes the picked project this client's active one.
 * Switching is client-only: no host request, no effect on other devices.
 * Archived projects render greyed + are not clickable. The currently active
 * project is marked.
 *
 * Epic 7 (cross-client continuity): a project `isDefault` (the host default,
 * set by the host's `default_project_id`) shows a "host default" badge. A
 * "Set as host default" action calls `set_host_default_project` (Tauri) or
 * `POST /projects/default` (web) depending on transport — distinct from the
 * client-only switch (which only updates this client's `activeProjectId`).
 */
export function ProjectSwitcherDrawer({
  open,
  onOpenChange,
  onAddProject,
  onOpenProjectSettings,
  side = 'left',
  id,
  onCloseAutoFocus
}: ProjectSwitcherDrawerProps): React.JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const { switchTo } = useProjectSwitch('ProjectSwitcherDrawer')
  const [defaultingId, setDefaultingId] = useState<string | null>(null)

  function handleSwitch(project: Project): void {
    if (switchTo(project.id) === 'selected') onOpenChange(false)
  }

  // Explicit host-default change (Epic 7). Distinct from the client-only
  // switch: updates the host default that new web clients start
  // with + publishes the project state to every `projects` watcher. Transport parity:
  // Tauri → `set_host_default_project`; web → `POST /projects/default`.
  async function handleSetDefault(project: Project): Promise<void> {
    if (defaultingId !== null) return
    setDefaultingId(project.id)
    try {
      const result = isTauriContext()
        ? await setHostDefaultProject(project.id)
        : await webServerProjects.setDefaultProject(project.id)
      if (!result.success) {
        // P15: guard against undefined error string (avoid "undefined" toast).
        toast.error(`Failed to set host default: ${result.error ?? 'unknown error'}`)
      } else {
        // P6: update isDefault flags locally so the badge refreshes
        // immediately (desktop-hosted mode doesn't refetch on set_default;
        // web mode receives the new list through the `projects` watch
        // but the local update avoids a flash of the stale badge).
        useProjectStore.setState((s) => ({
          projects: s.projects.map((p) => ({ ...p, isDefault: p.id === project.id }))
        }))
        toast.success(`"${project.name}" is now the host default`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDefaultingId(null)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        id={id}
        onCloseAutoFocus={onCloseAutoFocus}
        className={SIDE_CLASS_NAME[side]}
      >
        <SheetHeader className="space-y-0 border-b border-border/60 p-2 text-left">
          <div className="flex items-center gap-2 pr-8">
            <FolderGit2 size={20} />
            <SheetTitle className="text-base">Projects</SheetTitle>
          </div>
          <SheetDescription className="sr-only">
            Switch the session to another project or open the current project's settings
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {projects.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              No projects available. Add one to get started.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {projects.map((project) => {
                const isArchived = project.isArchived ?? false
                const isActive = project.id === activeProjectId
                const isHostDefault = project.isDefault === true
                const isSettingDefault = defaultingId === project.id
                const switchDisabled = isArchived || isActive
                return (
                  <li key={project.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={switchDisabled}
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => handleSwitch(project)}
                      className={[
                        'flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors duration-150 ease-out',
                        isActive ? 'keycap text-foreground' : 'hover:bg-foreground/[0.03]',
                        isArchived ? 'text-disabled-foreground' : '',
                        switchDisabled ? 'cursor-not-allowed' : 'cursor-pointer'
                      ].join(' ')}
                    >
                      <ProjectIcon project={project} size={18} />
                      <span
                        className={
                          isArchived
                            ? 'min-w-0 flex-1 truncate text-disabled-foreground'
                            : 'min-w-0 flex-1 truncate text-foreground'
                        }
                      >
                        {project.name}
                      </span>
                      {isActive && (
                        <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                          <Check size={12} aria-hidden="true" />
                          Current
                        </span>
                      )}
                      {isHostDefault && (
                        <span
                          title="Host default (new clients start here)"
                          className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
                        >
                          <Home size={12} />
                          Default
                        </span>
                      )}
                      {isActive ? <Check size={14} className="shrink-0 text-primary" /> : null}
                    </button>
                    {/* Project settings act on the active project only, so the
                     * gear sits on the Current row: on another row it would
                     * first have to switch the active project. */}
                    {isActive && onOpenProjectSettings && (
                      <button
                        type="button"
                        aria-label={`"${project.name}" project settings`}
                        title="Project settings"
                        onClick={() => {
                          onOpenChange(false)
                          onOpenProjectSettings()
                        }}
                        className="inline-flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground"
                      >
                        <Settings size={14} />
                      </button>
                    )}
                    {/* Set as host default (Epic 7) — distinct from the
                     * client-only switch. Hidden when already the host
                     * default (no-op), archived, or pathless (P5: a
                     * pathless project can't be a default — the host would
                     * reject it with NOT_FOUND). A truthy `project.path`
                     * also hides the control for an empty-string path, which
                     * the host would equally reject. */}
                    {!isHostDefault && !isArchived && !!project.path && (
                      <button
                        type="button"
                        disabled={isSettingDefault || defaultingId !== null}
                        aria-label={`Set "${project.name}" as host default`}
                        title="Set as host default"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleSetDefault(project)
                        }}
                        className={[
                          'inline-flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors',
                          isSettingDefault
                            ? 'cursor-wait'
                            : defaultingId !== null
                              ? 'cursor-not-allowed text-disabled-foreground'
                              : 'hover:bg-foreground/[0.03] hover:text-foreground'
                        ].join(' ')}
                      >
                        {isSettingDefault ? <Spinner size={14} decorative /> : <Home size={14} />}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {/* Pinned below the scrolling list so a long project list never pushes
         * the only creation entry out of reach. */}
        {onAddProject && (
          <div className="shrink-0 border-t border-border/60 p-2">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 w-full justify-start"
              onClick={() => {
                onOpenChange(false)
                onAddProject()
              }}
            >
              <Plus size={16} />
              Add project
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
