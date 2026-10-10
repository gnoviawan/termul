import { useEffect } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { saveTerminalLayout } from '@/hooks/useTerminalAutoSave'
import { flushSessionHistory } from '@/lib/acp-history-persistence'
import { loadCustomAgents } from '@/lib/agents/custom-agents'
import { setRouterNavigate } from '@/lib/router-navigate'
import { checkWebAuthGate } from '@/lib/web-auth-gate'
import { useAcpStore } from '@/stores/acp-store'
import { wireConnectionStatusTracking } from '@/stores/connection-status-store'

interface UseWorkspaceBootOptions {
  navigate: NavigateFunction
  activeProjectId: string
}

/**
 * One-shot boot wiring for the workspace layout: router navigate bridge, web
 * auth gate probe, custom-agent cache warm-up, connection-health feeds, and
 * the beforeunload/pagehide persistence flush.
 */
export function useWorkspaceBoot({ navigate, activeProjectId }: UseWorkspaceBootOptions): void {
  useEffect(() => {
    setRouterNavigate(navigate)
    return () => setRouterNavigate(null)
  }, [navigate])

  // #854: probe the web auth gate at boot. On a token-gated server a
  // missing/rotated token 401s the projects mirror (the `!isLoaded` branch
  // below would otherwise spin "Loading..." forever with no way to enter a
  // token — the exact bug). Resolving ok (desktop, ungated server, or valid
  // persisted token) leaves this layout untouched; `unauthorized` swaps the
  // loading state for the token-entry screen. A successful submission flips
  // the gate to ok and the projects loader (gated on
  // useWebAuthGateOk in use-projects-persistence.ts) re-fetches with the
  // fresh Authorization header.
  useEffect(() => {
    checkWebAuthGate()
  }, [])

  // Warm custom-agent cache so tab icons resolve before the launcher opens.
  useEffect(() => {
    void loadCustomAgents()
  }, [])
  // Story 10: wire the web connection-health feeds (control + terminal
  // channel) into the connection-status store once per workspace mount.
  // No-op on Tauri desktop (the store stays at initial values and the
  // StatusBar indicator renders nothing there).
  useEffect(() => {
    wireConnectionStatusTracking()
  }, [])

  useEffect(() => {
    const persistBeforeUnload = () => {
      if (!activeProjectId) return
      void saveTerminalLayout(activeProjectId).catch((error) => {
        console.warn('Failed to persist terminal layout before reload:', error)
      })
      // R4: force-flush a non-debounced snapshot of every live ACP session's
      // cached payload on refresh unload so the durable copy is at worst one
      // turn behind (never truncated by a live-window trim). Best-effort: a
      // hard refresh may still abort the in-flight async drain (matching
      // `persistSession`'s never-throw contract) — log on failure, never
      // throw on unload.
      try {
        useAcpStore.getState().flushLiveSessionSaves()
      } catch (error) {
        console.warn('Failed to snapshot ACP sessions before reload:', error)
      }
      void flushSessionHistory().catch((error) => {
        console.warn('Failed to flush ACP history before reload:', error)
      })
    }

    window.addEventListener('beforeunload', persistBeforeUnload)
    window.addEventListener('pagehide', persistBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', persistBeforeUnload)
      window.removeEventListener('pagehide', persistBeforeUnload)
    }
  }, [activeProjectId])
}
