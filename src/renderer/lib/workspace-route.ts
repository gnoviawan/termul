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
