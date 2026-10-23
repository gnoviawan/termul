/**
 * What the window knows about its termul-server. The launcher (Bun side) owns
 * the state machine and publishes each phase here; the status shell (app
 * side) only reads it. Runtime-neutral: no Bun or DOM types.
 */

/** Where the server came from, which decides whether quitting the app stops it. */
export type ServerOrigin =
  /** `TERMUL_SERVER_URL` named it. Never spawned, never stopped. */
  | 'attached'
  /** A launcher-managed server that was already running. Left running on quit. */
  | 'reused'
  /** Spawned by this app. Stopped on quit and on parent death. */
  | 'spawned'

export type ServerFailure =
  | { code: 'binary_not_found'; searched: string[] }
  | { code: 'version_mismatch'; expected: number; actual: number | null }
  | { code: 'unauthorized' }
  /** Another Termul host (the Tauri desktop app, another server) holds the data dir. */
  | { code: 'data_locked'; dataDir: string; holderPid: number | null }
  | { code: 'start_timeout'; timeoutMs: number }
  | { code: 'start_failed'; detail: string }
  /** Too many crashes in a row; the supervisor stopped restarting. */
  | { code: 'crash_loop'; crashes: number }
  | { code: 'unreachable'; detail: string }

export type ServerPhase =
  /** `after` names why the previous server died, on a restart. */
  | { kind: 'starting'; attempt: number; after: string | null }
  | { kind: 'ready'; origin: ServerOrigin; pid: number | null }
  /** The server died; a restart is scheduled. */
  | { kind: 'crashed'; detail: string; restartInMs: number; attempt: number }
  /** Terminal until the user retries. */
  | { kind: 'failed'; failure: ServerFailure }
  | { kind: 'stopped' }

export interface ServerStatus {
  get(): ServerPhase
  subscribe(listener: (phase: ServerPhase) => void): () => void
  /** Start again after a `failed` phase. A no-op in any other phase. */
  retry(): void
}

export function createStatusCell(initial: ServerPhase, onRetry: () => void) {
  let phase = initial
  const listeners = new Set<(phase: ServerPhase) => void>()
  const status: ServerStatus = {
    get: () => phase,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    retry() {
      if (phase.kind === 'failed') onRetry()
    }
  }
  const set = (next: ServerPhase): void => {
    phase = next
    for (const listener of listeners) listener(next)
  }
  return { status, set }
}

/** One line a person can act on. Shared by the status shell and the log. */
export function describeFailure(failure: ServerFailure): string {
  switch (failure.code) {
    case 'binary_not_found':
      return `termul-server was not found. Set TERMUL_SERVER_BIN or install it next to the app (searched ${failure.searched.length} places).`
    case 'version_mismatch':
      return `The termul-server speaks ${failure.actual === null ? 'another protocol version' : `protocol ${failure.actual}`}; this app needs ${failure.expected}. Install a matching termul-server.`
    case 'unauthorized':
      return 'The termul-server refused this app’s token.'
    case 'data_locked':
      return `Another Termul host owns ${failure.dataDir}${failure.holderPid ? ` (pid ${failure.holderPid})` : ''}. Quit the Termul desktop app or that server, then retry.`
    case 'start_timeout':
      return `termul-server did not become ready within ${Math.round(failure.timeoutMs / 1000)} s.`
    case 'start_failed':
      return `termul-server failed to start: ${failure.detail}`
    case 'crash_loop':
      return `termul-server crashed ${failure.crashes} times in a row.`
    case 'unreachable':
      return `termul-server is unreachable: ${failure.detail}`
  }
}
