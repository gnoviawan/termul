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

export function clearChatRoute(): void {
  if (!navigateFn) return
  if (window.location.hash.startsWith('#/c/')) {
    navigateFn('/')
  }
}
