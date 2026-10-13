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

export function navigateToChatSession(sessionId: string): void {
  if (!navigateFn) return
  if (!isChatRouteCurrent(sessionId)) {
    navigateFn(`/c/${sessionId}`)
  }
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
