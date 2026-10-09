import {
  FolderTree,
  GitBranch,
  Search,
  Settings,
  TerminalSquare,
  type TermulIcon
} from '@/components/icons'

/** A bottom-sheet action row: the `MobileFileExplorer` pattern at the 44px touch floor. */
export const SHEET_ROW_CLASS_NAME =
  'flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-sm'

/** Wraps the destructive row (Close chat, Close terminal) to set it apart from the rows above. */
export const SHEET_DESTRUCTIVE_DIVIDER_CLASS_NAME = 'mt-1 border-t border-border/60 pt-1'

/**
 * The shell navigation actions both ⋯ sheets can offer. Each row renders only
 * when its callback is given, so the owner decides which apply (web-only gates,
 * a project with a path, and so on).
 */
export interface ShellNavigationActions {
  onOpenGitChanges?: () => void
  onOpenFiles?: () => void
  onOpenCommandPalette?: () => void
  onNewTerminal?: () => void
  onOpenProjectSettings?: () => void
}

export interface ShellNavigationRow {
  label: string
  Icon: TermulIcon
  run: () => void
}

/**
 * The navigation rows whose callback is given, in the header ⋯ sheet's order:
 * Git changes, Files, Command palette, New terminal, Project settings. The
 * terminal ⋯ sheet passes no `onNewTerminal`, because the header ✎ already is
 * New terminal there.
 */
export function visibleNavigationRows(actions: ShellNavigationActions): ShellNavigationRow[] {
  const rows: Array<{ label: string; Icon: TermulIcon; run: (() => void) | undefined }> = [
    { label: 'Git changes', Icon: GitBranch, run: actions.onOpenGitChanges },
    { label: 'Files', Icon: FolderTree, run: actions.onOpenFiles },
    { label: 'Command palette', Icon: Search, run: actions.onOpenCommandPalette },
    { label: 'New terminal', Icon: TerminalSquare, run: actions.onNewTerminal },
    { label: 'Project settings', Icon: Settings, run: actions.onOpenProjectSettings }
  ]
  return rows.flatMap(({ label, Icon, run }) => (run ? [{ label, Icon, run }] : []))
}
