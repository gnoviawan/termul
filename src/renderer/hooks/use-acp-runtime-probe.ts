import { useEffect, useState } from 'react'
import { acpApi } from '@/lib/acp-api'
import type { AcpRuntimeAvailability } from '@/lib/agents/supported-acp-agents'

/**
 * Probe whether registry launchers (`npx` / `uvx`) are on PATH. Returns `null`
 * until the first probe completes so callers can avoid flashing needs-runtime.
 */
export function useAcpRuntimeProbe(): AcpRuntimeAvailability | null {
  const [runtime, setRuntime] = useState<AcpRuntimeAvailability | null>(null)

  useEffect(() => {
    let cancelled = false
    void acpApi
      .probeRuntime()
      .then((result) => {
        if (!cancelled) setRuntime(result)
      })
      .catch(() => {
        // A rejected probe must not leave the hook stuck at `null` (which
        // `buildSupportedAcpAgents` treats as "not yet probed" and keeps
        // launcher-backed agents appearing available) or surface an unhandled
        // rejection. Treat a failed probe as "no launchers available".
        if (!cancelled) setRuntime({ npx: false, uvx: false })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return runtime
}
