import type { ShellInfo } from '@shared/types/ipc.types'
import { Edit2, Globe, MessageSquare, Plus, Terminal as TerminalIcon } from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { openProjectCanvas } from '@/lib/open-project-canvas'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useActiveProject } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAvailableShells } from './use-available-shells'

/** Row look of the classic terminal menu (text-2xs rows, flush to the menu edge). */
const ROW_CLASS = 'min-h-0 gap-2 rounded-none px-2.5 py-1.5 text-2xs leading-none'

interface NewTabMenuProps {
  paneId: string
  onAddTerminal?: (shell?: ShellInfo) => void
  onAddBrowserTab?: () => void
  defaultShell?: string
}

/**
 * Revamp tab bar `+` menu: one trigger for New chat, New terminal (per
 * detected shell), New browser tab (desktop only) and Open canvas. Radix owns
 * keyboard, Esc and focus return.
 */
export function NewTabMenu({
  paneId,
  onAddTerminal,
  onAddBrowserTab,
  defaultShell
}: NewTabMenuProps): React.JSX.Element {
  const { loading, sortedShells } = useAvailableShells(defaultShell)
  const project = useActiveProject()
  const projectPath = project?.path
  const projectId = project?.id

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors duration-150 ease-out"
          title="New tab"
          aria-label="New tab"
        >
          <Plus size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44 p-0 shadow-lg">
        <DropdownMenuItem
          className={ROW_CLASS}
          disabled={!projectPath}
          onSelect={() => useWorkspaceStore.getState().showAgentLauncher(paneId)}
        >
          <MessageSquare size={11} />
          <span className="truncate">New chat</span>
        </DropdownMenuItem>

        {onAddTerminal && (
          <DropdownMenuGroup aria-label="Terminal">
            <div
              role="presentation"
              className="px-2.5 py-1 text-2xs font-medium text-muted-foreground bg-secondary/30"
            >
              Terminal
            </div>
            {loading ? (
              <div className="py-1 px-2.5 space-y-1.5">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : sortedShells && sortedShells.length > 0 ? (
              sortedShells.map((shell) => (
                <DropdownMenuItem
                  key={shell.name}
                  className={cn(ROW_CLASS, shell.name === defaultShell && 'text-primary')}
                  onSelect={() => onAddTerminal(shell)}
                >
                  <TerminalIcon size={11} />
                  <span className="truncate">{shell.displayName}</span>
                  {shell.name === defaultShell && (
                    <span className="ml-auto text-3xs text-muted-foreground">(default)</span>
                  )}
                </DropdownMenuItem>
              ))
            ) : (
              <div className="px-2.5 py-1.5 text-2xs text-muted-foreground">No shells detected</div>
            )}
          </DropdownMenuGroup>
        )}

        {onAddBrowserTab && isTauriContext() && (
          <DropdownMenuItem className={ROW_CLASS} onSelect={() => onAddBrowserTab()}>
            <Globe size={11} />
            <span className="truncate">New browser tab</span>
          </DropdownMenuItem>
        )}

        <DropdownMenuItem
          className={ROW_CLASS}
          disabled={!projectPath}
          onSelect={() => {
            if (projectId && projectPath) void openProjectCanvas(projectId, projectPath)
          }}
        >
          <Edit2 size={11} />
          <span className="truncate">Open canvas</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
