import {
  createContext,
  type KeyboardEvent,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState
} from 'react'
import { toast } from 'sonner'
import { Check, GitBranch, Plus, Terminal } from '@/components/icons'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { PopoverSearchBand } from '@/components/ui/popover-search-band'
import { Spinner } from '@/components/ui/spinner'
import { WriteGate } from '@/components/ui/write-gate'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { activeWorktreeOf, OUTSIDE_PROJECT_ROOT_REASON } from '@/lib/active-worktree'
import { openTerminalAtCwd } from '@/lib/terminal-spawn'
import { cn } from '@/lib/utils'
import { pickedWorkingCopy } from '@/lib/working-copy'
import {
  buildWorkspaceRows,
  filterWorkspaceRows,
  type WorkspaceRow,
  worktreeLabel,
  worktreeNameFromQuery
} from '@/lib/workspace-rows'
import { isEphemeralAcpSession, useAcpStore } from '@/stores/acp-store'
import { sessionTurnBusy } from '@/stores/prompt-queue-orchestration'
import { useShellLayoutStore, useWorktreePick } from '@/stores/shell-layout-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { getAllLeafPanes } from '@/stores/workspace-store/tree'
import type { Project } from '@/types/project'
import { useCreateWorktree } from '../use-create-worktree'
import { logRailEvent } from './rail-log'

const ROW_CLASS =
  'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground transition-colors duration-150 ease-out'
const ROW_HIGHLIGHT_CLASS = 'bg-foreground/[0.06]'

interface RailWorktreeSwitcherState {
  /** Project whose switcher is open, or `null`. */
  openProjectId: string | null
  setOpenProjectId: (projectId: string | null) => void
}

const RailWorktreeSwitcherContext = createContext<RailWorktreeSwitcherState>({
  openProjectId: null,
  setOpenProjectId: () => {}
})

/**
 * Owns which Rail project row shows its worktree switcher. The project row
 * menu ("Switch worktree…") opens it; at most one is open at a time.
 */
export function RailWorktreeSwitcherProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)
  const value = useMemo(() => ({ openProjectId, setOpenProjectId }), [openProjectId])
  return (
    <RailWorktreeSwitcherContext.Provider value={value}>
      {children}
    </RailWorktreeSwitcherContext.Provider>
  )
}

/** Opens the switcher of `projectId` (after the row menu that asked for it has closed). */
export function useOpenRailWorktreeSwitcher(): (projectId: string) => void {
  const { setOpenProjectId } = useContext(RailWorktreeSwitcherContext)
  return useCallback(
    (projectId: string) => {
      // The menu item closes its menu and returns focus to the row first; a
      // popover opened in the same tick would see that as an outside focus.
      setTimeout(() => setOpenProjectId(projectId), 0)
    },
    [setOpenProjectId]
  )
}

/**
 * Wraps one Rail project row (its anchor) with the worktree switcher popover:
 * the working copies of the project (project folder and listed worktrees),
 * search, create and a terminal action per row. Closing returns focus to the
 * row.
 */
export function RailWorktreeSwitcher({
  project,
  side = 'bottom',
  children
}: {
  project: Project
  side?: 'bottom' | 'right'
  /** The project row: the popover anchor. */
  children: React.ReactNode
}): React.JSX.Element {
  const { openProjectId, setOpenProjectId } = useContext(RailWorktreeSwitcherContext)
  const open = openProjectId === project.id
  const anchorRef = useRef<HTMLDivElement>(null)
  return (
    <Popover open={open} onOpenChange={(next) => setOpenProjectId(next ? project.id : null)}>
      <PopoverAnchor asChild>
        <div ref={anchorRef}>{children}</div>
      </PopoverAnchor>
      <PopoverContent
        side={side}
        align="start"
        aria-label="Working copies"
        className="w-80 overflow-hidden rounded-xl border bg-popover p-0 shadow-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          anchorRef.current?.querySelector<HTMLElement>('[role="button"],button')?.focus()
        }}
      >
        <WorktreeSwitcherPanel project={project} onClose={() => setOpenProjectId(null)} />
      </PopoverContent>
    </Popover>
  )
}

/** Height of the worktree chip line under a Rail project row (`h-4.5`). */
export const RAIL_WORKTREE_CHIP_HEIGHT = 18

/** The picked worktree the chip shows, or `undefined` for the project folder. */
export function usePickedWorktree(project: Project): ReturnType<typeof activeWorktreeOf> {
  return activeWorktreeOf(project, useWorktreePick(project.id))
}

/**
 * Muted chip under a Rail project name with the picked worktree (Sidebar V2
 * P4). Nothing when the pick is the project folder. The collapsed Rail keeps
 * the line's height with a branch glyph, so every icon stays at its y.
 */
export function RailWorktreeChip({
  project,
  collapsed
}: {
  project: Project
  collapsed: boolean
}): React.JSX.Element | null {
  const picked = usePickedWorktree(project)
  if (!picked) return null
  const label = worktreeLabel(picked)
  if (collapsed) {
    return (
      <div
        className="flex h-4.5 items-center justify-center text-muted-foreground"
        title={`Worktree: ${label}`}
        data-testid={`rail-worktree-chip-${project.id}`}
      >
        <GitBranch size={10} aria-hidden="true" />
        <span className="sr-only">Worktree: {label}</span>
      </div>
    )
  }
  return (
    <div
      className="flex h-4.5 min-w-0 items-start pr-3 pl-9"
      data-testid={`rail-worktree-chip-${project.id}`}
    >
      <span
        className="inline-flex h-4 min-w-0 max-w-full items-center gap-1 rounded bg-foreground/[0.06] px-1.5 text-3xs text-muted-foreground"
        title={picked.path}
      >
        <GitBranch size={10} className="shrink-0" aria-hidden="true" />
        <span className="sr-only">Worktree: </span>
        <span className="min-w-0 truncate">{label}</span>
      </span>
    </div>
  )
}

type Item = { type: 'row'; row: WorkspaceRow } | { type: 'create'; name: string }

function toastTerminalOutcome(
  outcome: Awaited<ReturnType<typeof openTerminalAtCwd>>,
  path: string
): void {
  if (outcome.status === 'opened') {
    toast.success('Terminal opened', { description: `Opened at ${path}` })
  } else if (outcome.status === 'no-pane') {
    toast.error('No active pane', {
      description: 'Cannot open terminal without an active workspace pane.'
    })
  } else {
    toast.error('Failed to open terminal', {
      description: outcome.error || 'Could not create a terminal.'
    })
  }
}

function WorktreeSwitcherPanel({
  project,
  onClose
}: {
  project: Project
  onClose: () => void
}): React.JSX.Element {
  const pick = useWorktreePick(project.id)
  const root = useWorkspaceStore((s) => s.root)
  const sessions = useAcpStore((s) => s.sessions)
  const terminals = useTerminalStore((s) => s.terminals)
  const admitted = useServerAdmitsRemoteWrites()
  const { create, creating, error, clearError } = useCreateWorktree(project)
  const [query, setQuery] = useState('')

  const rows = useMemo(
    () =>
      buildWorkspaceRows({
        project,
        tabs: getAllLeafPanes(root).flatMap((leaf) => leaf.tabs),
        sessions: Object.values(sessions).map((s) => ({
          id: s.id,
          projectId: s.projectId,
          cwd: s.cwd,
          busy: sessionTurnBusy(s),
          ephemeral: isEphemeralAcpSession(s.id)
        })),
        terminals
      }),
    [project, root, sessions, terminals]
  )
  const filtered = useMemo(() => filterWorkspaceRows(rows, query), [rows, query])
  const pickedKey = pickedWorkingCopy(project, pick)?.key ?? null
  // Start on the picked row; typing restarts from the top.
  const [highlight, setHighlight] = useState(() =>
    Math.max(
      0,
      rows.findIndex((r) => r.key === pickedKey)
    )
  )
  const changeQuery = (value: string): void => {
    setQuery(value)
    setHighlight(0)
    clearError()
  }

  const isGit = project.isGitRepo === true
  const trimmed = query.trim()
  const noMatch = trimmed !== '' && filtered.length === 0
  const createName = noMatch && isGit ? worktreeNameFromQuery(query) : ''
  const items = useMemo<Item[]>(
    () => [
      ...filtered.map((row): Item => ({ type: 'row', row })),
      ...(createName ? [{ type: 'create', name: createName } as Item] : [])
    ],
    [filtered, createName]
  )

  const choose = (row: WorkspaceRow): void => {
    if (row.outsideProjectRoot) return
    const worktree = row.kind === 'worktree'
    useShellLayoutStore.getState().setWorktreePick(project.id, worktree ? row.path : null)
    logRailEvent(
      `worktree switch for project ${project.id}: ${worktree ? 'a worktree' : 'the project folder'}`
    )
    onClose()
  }

  const openTerminal = async (row: WorkspaceRow): Promise<void> => {
    if (row.outsideProjectRoot) return
    onClose()
    toastTerminalOutcome(await openTerminalAtCwd(project.id, row.path), row.path)
  }

  const createWorktree = async (name: string): Promise<void> => {
    if (!admitted || creating) return
    if ((await create(name)) === 'created') onClose()
  }

  const activate = (item: Item | undefined): void => {
    if (!item) return
    if (item.type === 'row') choose(item.row)
    else void createWorktree(item.name)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (items.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((h) => (h + 1) % items.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((h) => (h - 1 + items.length) % items.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      activate(items[Math.min(highlight, items.length - 1)])
    }
  }

  const createHighlighted = items[highlight]?.type === 'create'

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: key handling for the search field inside */}
      <div onKeyDown={onKeyDown}>
        <PopoverSearchBand
          value={query}
          onChange={changeQuery}
          placeholder="Search or create a worktree…"
          ariaLabel="Search or create a worktree"
          autoFocus
          inputClassName="h-full text-xs"
        />
      </div>

      <div className="max-h-64 overflow-y-auto p-1">
        {filtered.length > 0 && (
          <div role="listbox" aria-label="Working copies" className="flex flex-col">
            {filtered.map((row, index) => (
              <WorkspaceRowView
                key={row.key}
                row={row}
                selected={row.key === pickedKey}
                highlighted={index === highlight && items[highlight]?.type === 'row'}
                onChoose={() => choose(row)}
                onHover={() => setHighlight(index)}
                onOpenTerminal={() => void openTerminal(row)}
              />
            ))}
          </div>
        )}

        {noMatch && (
          <div>
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
              No matching working copies
            </div>
            {createName && (
              <div className="border-t border-border pt-1">
                <WriteGate gated={!admitted} className="flex w-full">
                  <button
                    type="button"
                    disabled={!admitted || creating}
                    onClick={() => void createWorktree(createName)}
                    className={cn(
                      ROW_CLASS,
                      'w-full flex-none text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:cursor-default',
                      FOCUS_RING_CLASS,
                      createHighlighted && ROW_HIGHLIGHT_CLASS,
                      !admitted && 'opacity-40 cursor-not-allowed'
                    )}
                  >
                    {creating ? (
                      <Spinner size={13} decorative />
                    ) : (
                      <Plus size={13} className="shrink-0" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      Create worktree <span className="text-foreground">{createName}</span>
                    </span>
                  </button>
                </WriteGate>
                {error && (
                  <p role="alert" className="px-2.5 pt-1 text-2xs text-destructive">
                    {error}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function WorkspaceRowView({
  row,
  selected,
  highlighted,
  onChoose,
  onHover,
  onOpenTerminal
}: {
  row: WorkspaceRow
  selected: boolean
  highlighted: boolean
  onChoose: () => void
  onHover: () => void
  onOpenTerminal: () => void
}): React.JSX.Element {
  const disabled = row.outsideProjectRoot
  const tabs = `${row.openTabCount} open ${row.openTabCount === 1 ? 'tab' : 'tabs'}`
  const showStatus = row.openTabCount > 0 || row.running
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: presentational wrapper around the option and its action */}
        <div role="presentation" className="group flex items-center gap-1" onMouseMove={onHover}>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the search field */}
          <div
            role="option"
            aria-selected={selected}
            aria-disabled={disabled || undefined}
            tabIndex={-1}
            title={disabled ? OUTSIDE_PROJECT_ROOT_REASON : row.path}
            onClick={disabled ? undefined : onChoose}
            className={cn(
              ROW_CLASS,
              disabled
                ? 'cursor-not-allowed opacity-50'
                : 'cursor-default hover:bg-foreground/[0.06]',
              highlighted && !disabled && ROW_HIGHLIGHT_CLASS
            )}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              {selected && <Check size={13} className="text-foreground" aria-hidden="true" />}
            </span>
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {disabled && <span className="sr-only">{OUTSIDE_PROJECT_ROOT_REASON}</span>}
            {showStatus && (
              <span
                className="flex shrink-0 items-center gap-1.5 text-2xs tabular-nums text-muted-foreground"
                title={`${tabs}${row.running ? ', working' : ''}`}
              >
                {row.running && (
                  <span
                    aria-hidden="true"
                    data-testid="workspace-row-live-dot"
                    className="size-1.5 rounded-full bg-primary"
                  />
                )}
                {row.openTabCount > 0 && <span>{row.openTabCount}</span>}
              </span>
            )}
          </div>
          <button
            type="button"
            aria-label={`Open terminal in ${row.label}`}
            title={`Open terminal at ${row.path}`}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation()
              onOpenTerminal()
            }}
            className={cn(
              'relative inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground',
              "after:absolute after:-inset-1.5 after:content-['']",
              'transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
              'pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 focus-visible:opacity-100',
              highlighted && 'pointer-fine:opacity-100',
              disabled && 'cursor-not-allowed'
            )}
          >
            <Terminal size={12} aria-hidden="true" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem disabled={disabled} onSelect={onOpenTerminal}>
          <Terminal className="mr-2 h-4 w-4" /> Open Terminal Here
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
