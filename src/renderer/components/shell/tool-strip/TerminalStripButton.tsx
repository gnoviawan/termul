import type { ShellInfo } from '@shared/types/ipc.types'
import { Terminal } from '@/components/icons'
import { logShellEvent } from '@/components/shell/shell-log'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { isContextMenuKey, openContextMenuFrom } from '@/lib/context-menu-key'
import { useDefaultShell } from '@/stores/app-settings-store'
import { ToolStrip } from './ToolStrip'
import { useAvailableShells } from './use-available-shells'

interface TerminalStripButtonProps {
  /** The project's default shell setting, if any (else the app default). */
  projectShell?: string
  shortcut?: string
  disabled: boolean
  /** Opens a terminal tab: the default shell without an argument. */
  onNewTerminal: (shell?: ShellInfo) => void
}

/**
 * The tool strip Terminal button. A click opens a new terminal tab with the
 * default shell. Right-click, Shift+F10 or the context-menu key opens the
 * list of detected shells; picking one opens the tab with that shell.
 */
export function TerminalStripButton({
  projectShell,
  shortcut,
  disabled,
  onNewTerminal
}: TerminalStripButtonProps): React.JSX.Element {
  const appShell = useDefaultShell()
  const { loading, sortedShells, defaultShell } = useAvailableShells(projectShell || appShell)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled}>
        <ToolStrip.Button
          label="New terminal"
          hint="Right-click for other shells"
          shortcut={shortcut}
          disabled={disabled}
          aria-haspopup="menu"
          onClick={() => {
            logShellEvent('strip opens a terminal tab')
            onNewTerminal()
          }}
          onKeyDown={(event) => {
            if (!isContextMenuKey(event)) return
            event.preventDefault()
            openContextMenuFrom(event.currentTarget)
          }}
          icon={<Terminal size={14} aria-hidden />}
        />
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52" aria-label="Shells">
        <ContextMenuLabel className="text-2xs font-medium text-muted-foreground">
          New terminal with
        </ContextMenuLabel>
        {loading ? (
          <ContextMenuItem disabled>Detecting shells…</ContextMenuItem>
        ) : sortedShells && sortedShells.length > 0 ? (
          sortedShells.map((shell) => (
            <ContextMenuItem
              key={shell.path}
              onSelect={() => {
                logShellEvent(`strip opens a terminal tab with shell ${shell.name}`)
                onNewTerminal(shell)
              }}
            >
              <Terminal className="mr-2 h-4 w-4" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{shell.displayName}</span>
              {shell === defaultShell && (
                <span className="ml-2 text-2xs text-muted-foreground">Default</span>
              )}
            </ContextMenuItem>
          ))
        ) : (
          <ContextMenuItem disabled>No shells detected</ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
