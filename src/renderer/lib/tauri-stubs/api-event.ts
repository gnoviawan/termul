export type UnlistenFn = () => void

/** Resolve to a no-op unlisten so unguarded subscribe sites do not crash the web shell. */
export async function listen(
  _event: string,
  _handler: (event: { payload: unknown }) => void
): Promise<UnlistenFn> {
  return () => {}
}

export async function once(
  _event: string,
  _handler: (event: { payload: unknown }) => void
): Promise<UnlistenFn> {
  return () => {}
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {
  // fire-and-forget no-op in the web build
}
