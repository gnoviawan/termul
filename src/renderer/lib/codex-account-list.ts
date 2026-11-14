const listeners = new Set<() => void>()

/** Refresh every mounted Codex account list after a store change. */
export function subscribeCodexAccountList(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyCodexAccountListChanged(): void {
  for (const listener of listeners) listener()
}
