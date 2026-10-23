/** What the client knows about its server and its own files. Parsed once in `env/config.ts`. */
export interface ClientConfig {
  /** Origin of the termul-server to talk to (no path, query or fragment). */
  serverUrl: URL
  /** Bearer token for a gated server; `null` for an ungated loopback server. */
  token: string | null
  /** Where this client keeps its own files (persisted web storage). */
  stateDir: string
  /**
   * The server's host-local credential file, when this app started the
   * server and so shares its data dir; `null` when attached to a server.
   */
  hostLocalTokenFile: string | null
}
