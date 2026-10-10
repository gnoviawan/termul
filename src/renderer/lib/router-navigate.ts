let navigateFn: ((path: string) => void) | null = null

export function setRouterNavigate(fn: ((path: string) => void) | null): void {
  navigateFn = fn
}

export function navigateToChatSession(sessionId: string): void {
  if (!navigateFn) return
  const target = `/c/${sessionId}`
  if (window.location.hash !== `#${target}`) {
    navigateFn(target)
  }
}

/**
 * Leave the chat route. With `sessionId`, only when the URL still names that
 * session — a caller acting on a stale route (router updates run in a
 * transition) must not clobber a newer chat route.
 */
export function clearChatRoute(sessionId?: string): void {
  if (!navigateFn) return
  const hash = window.location.hash
  if (sessionId ? hash === `#/c/${sessionId}` : hash.startsWith('#/c/')) {
    navigateFn('/')
  }
}
