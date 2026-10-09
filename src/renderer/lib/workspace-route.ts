/**
 * True for the routes that render the pane workspace (`/` and the chat route
 * `/c/<id>`). Any other route (for example `/snapshots`) swaps the pane area
 * for the router outlet.
 *
 * Shared by `WorkspaceLayout` (which decides whether to mount the panes) and
 * `MobileChatShell` (whose drawer rows return to the workspace from any other
 * route), so the two can never disagree about what a workspace route is.
 */
export function isWorkspaceRoutePath(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/c/')
}

/**
 * Go back to the workspace (`/`) when `pathname` is not a workspace route, so a
 * tab that was just created or activated is actually visible. A no-op on `/` and
 * `/c/<id>`. Returns whether it navigated.
 *
 * The one helper the mobile shell's own entry points share (drawer rows, footer
 * Git history, New terminal in the drawer, header and ⋯ sheet, a file opened
 * from the Files sheet). Actions owned by `WorkspaceLayout`, such as the command
 * palette's, do not go through it.
 */
export function returnToWorkspaceRoute(pathname: string, navigate: (to: string) => void): boolean {
  if (isWorkspaceRoutePath(pathname)) return false
  navigate('/')
  return true
}
