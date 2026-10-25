let navigateFn: ((path: string) => void) | null = null

export function setRouterNavigate(fn: ((path: string) => void) | null): void {
  navigateFn = fn
}

/**
 * Whether the URL names the chat route of `sessionId`. Reads the live hash:
 * the router commits its location in a transition, so a route hook can still
 * name a chat route the URL already left. Only the path counts, as in route
 * matching: `#/c/<id>?…` is still that chat route.
 */
export function isChatRouteCurrent(sessionId: string): boolean {
  const [path] = window.location.hash.slice(1).split(/[?#]/, 1)
  return path === `/c/${sessionId}`
}

/**
 * The chat route the workspace store last navigated to after placing that
 * chat's tab itself. The router commits the location in a transition, so
 * `ChatRoute` can see the route only after the reader has moved on (opened
 * the launcher, picked another tab); placing the tab again then would undo
 * that. `ChatRoute` places a chat only for a route that came from elsewhere.
 */
let storePlacedRoute: string | null = null

/** Navigate to a chat whose tab the workspace store has just placed and activated. */
export function navigateToChatSession(sessionId: string): void {
  if (!navigateFn) return
  if (!isChatRouteCurrent(sessionId)) {
    storePlacedRoute = sessionId
    navigateFn(`/c/${sessionId}`)
  }
}

/**
 * Carry a chat route over a session id swap (a launch placeholder's real id,
 * an agent switch), only when the URL still names the old id. The remap
 * renamed the tab where it stood.
 */
export function followChatRemap(fromSessionId: string, toSessionId: string): void {
  if (!navigateFn || !isChatRouteCurrent(fromSessionId)) return
  storePlacedRoute = toSessionId
  navigateFn(`/c/${toSessionId}`)
}

/** Whether the store placed the tab of the chat route `sessionId` (answers once). */
export function consumeStorePlacedRoute(sessionId: string): boolean {
  if (storePlacedRoute !== sessionId) return false
  storePlacedRoute = null
  return true
}

/**
 * Leave the chat route. With `sessionId`, only when the URL still names that
 * session — a caller acting on a stale route (router updates run in a
 * transition) must not clobber a newer chat route.
 */
export function clearChatRoute(sessionId?: string): void {
  if (!navigateFn) return
  if (sessionId ? isChatRouteCurrent(sessionId) : window.location.hash.startsWith('#/c/')) {
    navigateFn('/')
  }
}
