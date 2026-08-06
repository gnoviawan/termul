import { AlertCircle, Check, Clock3, FolderGit2, Home, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { getColorClasses } from '@/lib/colors'
import { setHostDefaultProject } from '@/lib/tauri-remote-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { webServerProjects } from '@/lib/web-server-api'
import { useAcpStore } from '@/stores/acp-store'
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
  onOpenChange
}: ProjectSwitcherDrawerProps): React.JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const switchProject = useAcpStore((s) => s.switchProject)
  const queuedProjectSwitchId = useAcpStore((s) => s.queuedProjectSwitchId)
  const failedProjectSwitchId = useAcpStore((s) => s.failedProjectSwitchId)
  const setFailedProjectSwitch = useAcpStore((s) => s.setFailedProjectSwitch)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [defaultingId, setDefaultingId] = useState<string | null>(null)

  // The inline "Failed" badge is transient: dismiss it when the drawer closes
  // so a stale red indicator doesn't reappear on the next open. A fresh switch
  // attempt also clears it (see `switchProject`), so retrying self-heals. The
  // `failedProjectSwitchId` dep covers a failure that arrives AFTER the drawer
  // closes (e.g. a queued switch rejected while closed) — the effect re-runs
  // and clears it immediately so no stale badge resurfaces on reopen.
  useEffect(() => {
    if (!open && failedProjectSwitchId !== null) setFailedProjectSwitch(null)
  }, [open, failedProjectSwitchId, setFailedProjectSwitch])

  async function handleSwitch(project: Project): Promise<void> {
    if (switchingId !== null) return
    setSwitchingId(project.id)
    try {
      const outcome = await switchProject(project.id)
      if (outcome.status === 'completed' || outcome.status === 'selected') {
        onOpenChange(false)
      }
    } catch (err) {
      // `AcpTransportError.message` is the human string callers already toast
      // (e.g. "no_agent" → "switch_project requires a live agent; …"). Surface
      // the failure inline too — toasts are easy to miss on mobile.
      setFailedProjectSwitch(project.id)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSwitchingId(null)
    }
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
                const isHostDefault = project.isDefault === true
                const isSwitching = switchingId === project.id
                const isSettingDefault = defaultingId === project.id
                const isQueued = queuedProjectSwitchId === project.id
                const isFailed = failedProjectSwitchId === project.id
                const switchDisabled =
                  isArchived || isActive || switchingId !== null || queuedProjectSwitchId !== null
                return (
                  <li key={project.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={switchDisabled}
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => void handleSwitch(project)}
                      className={[
                        'flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-sm transition-colors',
                        isActive ? 'bg-primary/20' : 'hover:bg-sidebar-accent/50',
                        isArchived ? 'opacity-50' : '',
                        switchDisabled ? 'cursor-not-allowed' : 'cursor-pointer'
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
                        <Loader2
                          size={14}
                          className="shrink-0 animate-spin text-muted-foreground"
                        />
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
                          'shrink-0 rounded p-1.5 text-muted-foreground transition-colors',
                          isSettingDefault
                            ? 'cursor-wait'
                            : defaultingId !== null
                              ? 'cursor-not-allowed opacity-50'
                              : 'hover:bg-sidebar-accent/50 hover:text-foreground'
                        ].join(' ')}
                      >
                        {isSettingDefault ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Home size={14} />
                        )}
                      </button>
                    )}
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
