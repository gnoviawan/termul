import { useEffect } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'

/**
 * Load the persisted MCP server registry once at app mount, then auto-probe
 * every enabled server once so status dots and tool lists are populated
 * without visiting Settings. User expectation: a configured server is always
 * "on" (status + tools visible in the Agent launcher and chatbox MCP popovers)
 * unless explicitly toggled off in the registry.
 *
 * The pass runs only after the registry resolves (both roots mount this hook —
 * desktop `TauriApp` and web `App`). A server id is probed at most once per
 * app run (module-scope set): toggling other servers off/on never re-probes
 * it, a newly added server is probed automatically, and a re-enabled one
 * refills on the next popover expand via `loadMcpTools` (which still
 * auto-probes unloaded ids). A root remount (StrictMode-style double-mount,
 * error-boundary retry) is the same app run, so it does not re-fan-out.
 * `probeMcpServer` is read-only, never throws, and dedupes concurrent probes
 * per id — a popover expand mid-probe cannot double-probe.
 */

// Per-app-run probe bookkeeping (module scope — survives root remounts).
// Dynamic membership with insertion at runtime → Set (project rule).
const autoProbedServerIds = new Set<string>()

/**
 * True when the boot auto-probe pass already covered `id` this app run.
 * Surfaces (e.g. McpServersSettings' on-mount pass) use this to skip a
 * duplicate probe for servers whose status is already live.
 */
export function isMcpServerAutoProbed(id: string): boolean {
  return autoProbedServerIds.has(id)
}

/** Mark `id` as covered by the auto-probe pass (probe fan-out caller). */
export function markMcpServerAutoProbed(id: string): void {
  autoProbedServerIds.add(id)
}

/** Test-only: clear the per-app-run probe set between tests. */
export function _resetAutoProbedMcpServersForTesting(): void {
  autoProbedServerIds.clear()
}

export function useAcpMcp(): void {
  const loadMcpServers = useAcpStore((s) => s.loadMcpServers)
  const probeMcpServer = useAcpStore((s) => s.probeMcpServer)
  const mcpServers = useAcpStore((s) => s.mcpServers)
  const mcpServersLoaded = useAcpStore((s) => s.mcpServersLoaded)
  // Registry load — best-effort; the store's action catches its own failures
  // (toast + boundary log), and the `.catch` here guards a transport-level
  // rejection from surfacing as an unhandled rejection.
  useEffect(() => {
    loadMcpServers().catch((err: unknown) => {
      void logFrontendError({
        source: 'acp.useAcpMcp',
        message: `MCP registry load rejected (${String(err)})`
      })
    })
  }, [loadMcpServers])

  // Auto-probe pass — only after the registry has loaded, and each enabled
  // id at most once per app run (`autoProbedServerIds`). `mcpServers` is
  // replaced (not mutated) by every store action, so this effect re-runs on
  // each registry change and picks up newly added servers. Deferred to
  // browser/WebView idle (mirrors main.tsx's CodeMirror preload deferral,
  // issue #378) so a fleet of stdio probes never competes with first paint.
  useEffect(() => {
    if (!mcpServersLoaded) return
    const toProbe = mcpServers.filter((s) => s.enabled !== false && !isMcpServerAutoProbed(s.id))
    if (toProbe.length === 0) return
    for (const server of toProbe) {
      markMcpServerAutoProbed(server.id)
    }
    const runPass = (): void => {
      // Boundary log for the new flow — count only, no server configs.
      void logFrontendError({
        level: 'info',
        source: 'acp.useAcpMcp',
        message: `Auto-probe pass covering ${toProbe.length} enabled MCP server${toProbe.length === 1 ? '' : 's'}`
      })
      for (const server of toProbe) {
        probeMcpServer(server.id).catch((err: unknown) => {
          void logFrontendError({
            source: 'acp.useAcpMcp',
            message: `MCP auto-probe rejected for server id '${server.id}' (${String(err)})`
          })
        })
      }
    }
    if ('requestIdleCallback' in globalThis) {
      globalThis.requestIdleCallback(runPass, { timeout: 2_000 })
    } else {
      setTimeout(runPass, 1_000)
    }
  }, [mcpServersLoaded, mcpServers, probeMcpServer])
}
