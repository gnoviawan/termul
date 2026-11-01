import { join } from 'node:path'

/**
 * CLI args for the suite's isolated termul-server. Every persisted path is
 * pinned inside the throwaway `stateDir` by an explicit flag: the server
 * resolves each one from its flag first, then from a `TERMUL_*` env var, and
 * only then from the state dir. The child inherits the developer's env, so a
 * missing flag would let an exported `TERMUL_STORE_FILE` (or similar) point
 * the seeded server at the developer's real file (issue #1624).
 */
export function seededServerArgs(opts: { port: number; stateDir: string }): string[] {
  return [
    '--host',
    '127.0.0.1',
    '--port',
    String(opts.port),
    '--state-dir',
    opts.stateDir,
    '--sessions-dir',
    join(opts.stateDir, 'sessions'),
    '--projects-file',
    join(opts.stateDir, 'projects.json'),
    '--store-file',
    join(opts.stateDir, 'store.json')
  ]
}
