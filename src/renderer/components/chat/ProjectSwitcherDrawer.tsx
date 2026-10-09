import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, Check, Clock3, FolderGit2, Home, Plus } from '@/components/icons'
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
import { useProjectSwitch, useProjectSwitchState } from '@/hooks/use-project-switch'
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
 * via `GET /projects`) and switches the shared-live session to a project's cwd
 * via the `switch_project` WS request. Archived projects render greyed + are
 * not clickable. The currently active project is marked. The Tauri desktop
 * transport has no `switchProject` — this drawer is mounted only in web/remote
 * mode, so a missing method is a no-op (defensive).
 *
 * Epic 7 (cross-client continuity): a project `isDefault` (the host default,
 * set by the host's `default_project_id`) shows a "host default" badge. A
 * "Set as host default" action calls `set_host_default_project` (Tauri) or
 * `POST /projects/default` (web) depending on transport — distinct from the
 * per-connection `switch_project` (which only updates this client's
 * `activeProjectId` and never broadcasts).
 */
export function ProjectSwitcherDrawer({
  open,
  onOpenChange,
  onAddProject,
  side = 'left',
  id,
  onCloseAutoFocus
}: ProjectSwitcherDrawerProps): React.JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const { switchTo, clearFailed } = useProjectSwitch('ProjectSwitcherDrawer')
  const {
    switchingId,
    queuedId: queuedProjectSwitchId,
    failedId: failedProjectSwitchId,
    busy: switchBusy
  } = useProjectSwitchState()
  const [defaultingId, setDefaultingId] = useState<string | null>(null)

  // The inline "Failed" badge is transient: dismiss it when the drawer closes
  // so a stale red indicator doesn't reappear on the next open. A fresh switch
  // attempt also clears it (see `switchProject`), so retrying self-heals. The
  // `failedProjectSwitchId` dep covers a failure that arrives AFTER the drawer
  // closes (e.g. a queued switch rejected while closed) — the effect re-runs
  // and clears it immediately so no stale badge resurfaces on reopen.
  useEffect(() => {
    if (!open && failedProjectSwitchId !== null) clearFailed()
  }, [open, failedProjectSwitchId, clearFailed])

  // While a switch is in flight or queued (`switchBusy`) rows stay focusable
  // (`aria-disabled`, not `disabled`, so the focused row keeps focus) and the
  // hook ignores taps. The palette shares the routine, so the spinner and the
  // Queued badge also show for a switch it started.
  async function handleSwitch(project: Project): Promise<void> {
    const status = await switchTo(project.id)
    if (status === 'completed' || status === 'selected') onOpenChange(false)
  }

  // Explicit host-default change (Epic 7). Distinct from `switchProject`
  // (per-connection): updates the host default that new web clients start
  // with + broadcasts `projects_changed` to ALL clients. Transport parity:
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
        toast.error('Failed to set host default: ' + (result.error ?? 'unknown error'))
      } else {
        // P6: update isDefault flags locally so the badge refreshes
        // immediately (desktop-hosted mode doesn't refetch on set_default;
        // web mode refetches on the subsequent projects_changed broadcast
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
            Switch the session to another project
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
                const isSwitching = switchingId === project.id
                const isSettingDefault = defaultingId === project.id
                const isQueued = queuedProjectSwitchId === project.id
                const isFailed = failedProjectSwitchId === project.id
                const switchDisabled = isArchived || isActive
                const switchBlocked = switchDisabled || switchBusy
                return (
                  <li key={project.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={switchDisabled}
                      aria-disabled={switchBusy && !switchDisabled ? 'true' : undefined}
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => void handleSwitch(project)}
                      className={[
                        'flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors duration-150 ease-out',
                        isActive ? 'keycap text-foreground' : 'hover:bg-foreground/[0.03]',
                        isArchived ? 'text-disabled-foreground' : '',
                        switchBlocked ? 'cursor-not-allowed' : 'cursor-pointer'
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
                      {isActive && !isSwitching && !isQueued && !isFailed && (
                        <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                          <Check size={12} aria-hidden="true" />
                          Current
                        </span>
                      )}
                      {isHostDefault && !isSwitching && !isQueued && !isFailed && (
                        <span
                          title="Host default (new clients start here)"
                          className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
                        >
                          <Home size={12} />
                          Default
                        </span>
                      )}
                      {isSwitching ? (
                        <Spinner size={14} decorative className="text-muted-foreground" />
                      ) : isQueued ? (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          <Clock3 size={13} />
                          Queued
                        </span>
                      ) : isFailed ? (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-destructive">
                          <AlertCircle size={13} />
                          Failed
                        </span>
                      ) : isActive ? (
                        <Check size={14} className="shrink-0 text-primary" />
                      ) : null}
                    </button>
                    {/* Set as host default (Epic 7) — distinct from the
                     * per-connection switch. Hidden when already the host
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
