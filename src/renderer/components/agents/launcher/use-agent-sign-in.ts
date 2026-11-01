import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { AuthMethod } from '@/lib/acp-api'
import { resolveAgentEnv } from '@/lib/agent-launch'
import { resolveEnvForSpawn } from '@/lib/env-parser'
import { logFrontendError } from '@/lib/log-api'
import { terminalApi } from '@/lib/terminal-api'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { spawnAcpLoginTerminal } from './spawn-acp-login-terminal'

/**
 * How an advertised auth method is driven: 'agent' (or a missing type — the
 * pre-extension wire only carried agent methods) → provider-owned
 * authenticate; 'terminal' → login terminal tab; 'gateway' → the banner's URL
 * form; 'inline-key' → the agent policy's key form (Factory); anything else
 * ('env_var', 'unknown', future variants) → unsupported. Unknown types are
 * NEVER sent to `authenticate` — the host would reject an id it cannot drive.
 */
export type AuthMethodRoute = 'agent' | 'terminal' | 'gateway' | 'inline-key' | 'unsupported'

export function authMethodRoute(method: AuthMethod, inlineKeyMethodId?: string): AuthMethodRoute {
  if (inlineKeyMethodId != null && method.id === inlineKeyMethodId) return 'inline-key'
  if (method.type === 'terminal') return 'terminal'
  if (method.id === 'gateway') return 'gateway'
  if (method.type === 'agent' || method.type == null) return 'agent'
  return 'unsupported'
}

/** The agent process to sign in, and where its login terminal would open. */
export interface SignInAgent {
  /** The live agent that advertised the methods; null when none runs. */
  agentId: string | null
  config: StoredAgentConfig | null
  cwd: string | undefined
  projectId: string | null
  /** The pane a terminal method's login tab opens in, read when it opens. */
  resolvePaneId: () => string | null
  /** Boundary-log source naming the surface that drives the sign-in. */
  logSource: string
}

const NOT_CONNECTED = 'Agent is not connected. Use Retry to reconnect, then sign in again.'

/**
 * Drive an agent's advertised sign-in methods, then call `onSignedIn` so the
 * caller prepares again now that the provider login is complete. The provider
 * owns the login UX (often opening its own browser); Termul never invents a
 * redirect URL or stores credentials. Mirrors Zed's
 * ThreadState::Unauthenticated → authenticate → reset flow.
 */
export function useAgentSignIn(
  agent: SignInAgent,
  onSignedIn: () => void
): {
  signingInMethodId: string | null
  runAuthenticate: (
    methodId: string,
    gateway?: { baseUrl: string; apiKey?: string }
  ) => Promise<void>
  runTerminalAuth: (method: AuthMethod) => Promise<void>
} {
  const { agentId, config, cwd, projectId, resolvePaneId, logSource } = agent
  const [signingInMethodId, setSigningInMethodId] = useState<string | null>(null)
  const agentName = config?.name ?? 'the agent'
  const projectEnvVars = useProjectStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId)?.envVars : undefined
  )

  const runAuthenticate = useCallback(
    async (methodId: string, gateway?: { baseUrl: string; apiKey?: string }) => {
      if (!agentId) {
        toast.error(NOT_CONNECTED)
        return
      }
      if (signingInMethodId) return
      setSigningInMethodId(methodId)
      // The method id is advertised metadata, never a credential; the gateway
      // key stays out of the log.
      void logFrontendError({
        level: 'info',
        source: logSource,
        message: `Signing in to ${agentName} with '${methodId}'`
      })
      try {
        const store = useAcpStore.getState()
        if (gateway) await store.authenticateAgent(agentId, methodId, gateway)
        else await store.authenticateAgent(agentId, methodId)
        onSignedIn()
      } catch (err) {
        // The store already logs the redacted failure; the agent's message may
        // echo credentials, so it goes to the toast only.
        void logFrontendError({
          level: 'warn',
          source: logSource,
          message: `Sign-in to ${agentName} with '${methodId}' failed`
        })
        toast.error(err instanceof Error ? err.message : 'Sign-in failed')
      } finally {
        setSigningInMethodId(null)
      }
    },
    [agentId, agentName, logSource, signingInMethodId, onSignedIn]
  )

  // Terminal auth methods (spec-acp-terminal-auth): spawn the agent binary
  // with the method's args/env in a real terminal tab so its login TUI runs
  // interactively. Exit code 0 → run the ACP `authenticate` + re-prepare;
  // non-zero → toast and the sign-in actions stay (the user can retry). The
  // login terminal is an ordinary extra tab — never killed or recreated.
  const loginAuthInFlightRef = useRef(false)
  const loginExitUnlistenRef = useRef<(() => void) | null>(null)
  // Detach a pending login-exit listener on unmount — the terminal outlives
  // the surface, but the callback must not fire into a dead component.
  useEffect(
    () => () => {
      loginExitUnlistenRef.current?.()
      loginExitUnlistenRef.current = null
    },
    []
  )
  const runTerminalAuth = useCallback(
    async (method: AuthMethod) => {
      if (!agentId || !config || !cwd || !projectId) {
        toast.error(NOT_CONNECTED)
        return
      }
      const paneId = resolvePaneId()
      if (!paneId) {
        toast.error(`Open a new chat with ${agentName} to sign in with ${method.name}.`)
        return
      }
      // Ref guard: `signingInMethodId` state races a fast double-click and
      // would spawn duplicate login terminals.
      if (loginAuthInFlightRef.current) return
      loginAuthInFlightRef.current = true
      const liveAgentId = agentId
      setSigningInMethodId(method.id)
      void logFrontendError({
        level: 'info',
        source: logSource,
        message: `Opening the ${agentName} sign-in terminal for '${method.id}'`
      })
      let ptyId: string | null = null
      // The listener and the post-spawn getExitCode poll can both observe the
      // same exit — handle it once.
      let exitHandled = false
      const handleExit = (exitCode: number): void => {
        if (exitHandled) return
        exitHandled = true
        loginExitUnlistenRef.current?.()
        loginExitUnlistenRef.current = null
        loginAuthInFlightRef.current = false
        setSigningInMethodId(null)
        if (exitCode === 0) {
          // The login TUI writes credentials itself, so `authenticate`
          // typically returns immediately — it also covers agents that gate
          // on the explicit call. `authenticateAgent` shares the in-flight
          // dedup + marks the agent authenticated so `createSession` skips
          // its own authenticate. Re-prepare regardless of the authenticate
          // outcome: the TUI already wrote credentials, so the session can
          // proceed even when the explicit call fails.
          void useAcpStore
            .getState()
            .authenticateAgent(liveAgentId, method.id)
            .catch((err) => {
              toast.error(err instanceof Error ? err.message : 'Sign-in failed')
            })
            .finally(() => onSignedIn())
        } else {
          void logFrontendError({
            level: 'warn',
            source: logSource,
            message: `The ${agentName} sign-in terminal exited with code ${exitCode}`
          })
          toast.error(`${agentName} sign-in exited with code ${exitCode}.`)
        }
      }
      const failSpawn = (message: string): void => {
        loginExitUnlistenRef.current = null
        loginAuthInFlightRef.current = false
        setSigningInMethodId(null)
        void logFrontendError({
          level: 'warn',
          source: logSource,
          message: `Could not open the ${agentName} sign-in terminal`
        })
        toast.error(message)
      }
      // Register the exit listener BEFORE spawn so an exit that lands while
      // the spawn is in flight is still observed; the getExitCode poll below
      // covers the remaining gap (exit before the listener attached).
      const unlisten = terminalApi.onExit((id, exitCode) => {
        if (ptyId === null || id !== ptyId) return
        handleExit(exitCode)
      })
      loginExitUnlistenRef.current = unlisten
      try {
        // Merge project env → agent-config env → method env (same layering
        // as launchAgentInPane; method env wins — it is the auth flow's own
        // contract).
        const { env: projectEnv } = resolveEnvForSpawn(projectEnvVars, {})
        const mergedEnv = {
          ...projectEnv,
          ...resolveAgentEnv(config.env, projectEnv),
          ...(method.env ?? {})
        }
        const spawnResult = await spawnAcpLoginTerminal({
          paneId,
          projectId,
          cwd,
          program: config.command,
          // `AuthMethodTerminal.args` are ADDITIONAL args appended to the
          // agent's configured argv (devin advertises `["--login"]` →
          // `devin acp --login`). Dropping config.args would yield
          // `devin --login` — works for devin's hidden top-level flag but
          // breaks agents whose login lives under the configured subcommand.
          args: [...(config.args ?? []), ...(method.args ?? [])],
          ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
          tabName: `Sign in — ${agentName}`
        })
        if (!spawnResult.success || !spawnResult.ptyId) {
          unlisten()
          failSpawn(spawnResult.error ?? 'Could not open the sign-in terminal.')
          return
        }
        ptyId = spawnResult.ptyId
        // Fallback: the login process may have exited between spawn and the
        // listener observing it — poll the recorded exit code once.
        const exitResult = await terminalApi.getExitCode(ptyId)
        if (exitResult.success && exitResult.data !== null) {
          handleExit(exitResult.data)
        }
      } catch (err) {
        unlisten()
        failSpawn(err instanceof Error ? err.message : 'Could not open the sign-in terminal.')
      }
    },
    [
      agentId,
      agentName,
      config,
      cwd,
      projectId,
      projectEnvVars,
      resolvePaneId,
      logSource,
      onSignedIn
    ]
  )

  return { signingInMethodId, runAuthenticate, runTerminalAuth }
}
