import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EMPTY_AUTH_METHODS } from '@/components/agents/launcher/constants'
import {
  type FactoryKeyAuth,
  useFactoryKeyAuth
} from '@/components/agents/launcher/FactoryApiKeyForm'
import { spawnAcpLoginTerminal } from '@/components/agents/launcher/spawn-acp-login-terminal'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { AuthMethod } from '@/lib/acp-api'
import { resolveAgentEnv } from '@/lib/agent-launch'
import { agentPolicy } from '@/lib/agents/acp-registry'
import { resolveEnvForSpawn } from '@/lib/env-parser'
import { terminalApi } from '@/lib/terminal-api'
import { agentReuseKey, useAcpStore } from '@/stores/acp-store'
import type { EnvVariable } from '@/types/project'

export interface AgentSignIn {
  /** The methods the live agent advertises (empty until it has started). */
  authMethods: AuthMethod[]
  /** The one advertised method a single Sign in button can run, or null. */
  signInMethod: AuthMethod | null
  signingInMethodId: string | null
  factoryKeyAuth: FactoryKeyAuth
  /** The method the agent's auth policy shows as an inline key form. */
  inlineKeyMethodId: string | undefined
  handleAuthMethod: (method: AuthMethod) => void
  runAuthenticate: (
    methodId: string,
    gateway?: { baseUrl: string; apiKey?: string }
  ) => Promise<void>
  handleSignIn: () => void
}

/**
 * Sign-in for one agent config in one folder, driven by the methods its live
 * agent advertises: ACP `authenticate`, a login terminal tab, or the inline
 * key form. `onSignedIn` re-prepares the chat so the new credentials apply.
 * The launcher and the phone model sheet's setup screen share it.
 */
export function useAgentSignIn({
  registryAgentId,
  config,
  cwd,
  projectId,
  projectEnvVars,
  paneId,
  onSignedIn
}: {
  registryAgentId: string | null
  config: StoredAgentConfig | null
  cwd: string | undefined
  projectId: string | null
  projectEnvVars: EnvVariable[] | undefined
  /** Where a terminal sign-in method opens its login tab. */
  paneId: string
  onSignedIn: () => void
}): AgentSignIn {
  const configId = config?.id ?? ''
  // Resolve the live agent for this config+cwd so an auth failure can offer a
  // Sign-in action driven by the agent's advertised method metadata. A Sign-in
  // button is only meaningful when exactly one method is advertised (P6).
  const reuseKey = configId && cwd ? agentReuseKey(configId, cwd) : null
  const liveAgentId = useAcpStore((s) =>
    reuseKey ? (s.configToLiveAgent?.[reuseKey] ?? null) : null
  )
  const authMethods = useAcpStore((s) =>
    liveAgentId ? (s.agents?.[liveAgentId]?.authMethods ?? EMPTY_AUTH_METHODS) : EMPTY_AUTH_METHODS
  )
  const signInMethod =
    authMethods.length === 1 && authMethods[0]?.id !== 'gateway' ? authMethods[0] : null
  const [signingInMethodId, setSigningInMethodId] = useState<string | null>(null)

  const factoryKeyAuth = useFactoryKeyAuth(config, cwd, onSignedIn)

  // Run the agent-advertised authenticate for a chosen method, then re-prepare
  // so the session is created now that the provider login is complete. The
  // provider owns the login UX (often opening its own browser); Termul never
  // invents a redirect URL or stores credentials. Mirrors Zed's
  // ThreadState::Unauthenticated → authenticate → reset flow.
  const runAuthenticate = useCallback(
    async (methodId: string, gateway?: { baseUrl: string; apiKey?: string }) => {
      if (!liveAgentId) {
        toast.error('Agent is not connected. Use Retry to reconnect, then sign in again.')
        return
      }
      if (signingInMethodId) return
      setSigningInMethodId(methodId)
      try {
        const store = useAcpStore.getState()
        if (gateway) await store.authenticateAgent(liveAgentId, methodId, gateway)
        else await store.authenticateAgent(liveAgentId, methodId)
        onSignedIn()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Sign-in failed')
      } finally {
        setSigningInMethodId(null)
      }
    },
    [liveAgentId, signingInMethodId, onSignedIn]
  )

  // Terminal auth methods (spec-acp-terminal-auth): spawn the agent binary
  // with the method's args/env in a real terminal tab so its login TUI runs
  // interactively. Exit code 0 → run the ACP `authenticate` + re-prepare;
  // non-zero → toast and the banner stays (the user can retry). The login
  // terminal is an ordinary extra tab — never killed or recreated.
  const loginAuthInFlightRef = useRef(false)
  const loginExitUnlistenRef = useRef<(() => void) | null>(null)
  // Detach a pending login-exit listener on unmount — the terminal outlives
  // the caller, but the callback must not fire into a dead component.
  useEffect(
    () => () => {
      loginExitUnlistenRef.current?.()
      loginExitUnlistenRef.current = null
    },
    []
  )
  const runTerminalAuth = useCallback(
    async (method: AuthMethod) => {
      if (!liveAgentId || !config || !cwd || !projectId) {
        toast.error('Agent is not connected. Use Retry to reconnect, then sign in again.')
        return
      }
      // Ref guard: `signingInMethodId` state races a fast double-click and
      // would spawn duplicate login terminals.
      if (loginAuthInFlightRef.current) return
      loginAuthInFlightRef.current = true
      const agentId = liveAgentId
      const agentName = config.name
      setSigningInMethodId(method.id)
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
            .authenticateAgent(agentId, method.id)
            .catch((err) => {
              toast.error(err instanceof Error ? err.message : 'Sign-in failed')
            })
            .finally(() => onSignedIn())
        } else {
          toast.error(`${agentName} sign-in exited with code ${exitCode}.`)
        }
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
          loginExitUnlistenRef.current = null
          loginAuthInFlightRef.current = false
          setSigningInMethodId(null)
          toast.error(spawnResult.error ?? 'Could not open the sign-in terminal.')
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
        loginExitUnlistenRef.current = null
        loginAuthInFlightRef.current = false
        setSigningInMethodId(null)
        toast.error(err instanceof Error ? err.message : 'Could not open the sign-in terminal.')
      }
    },
    [liveAgentId, config, cwd, projectId, projectEnvVars, paneId, onSignedIn]
  )

  // The inline-key method from the selected agent's auth policy (replaces the
  // former `'factory-droid'` / `'factory-api-key'` magic-string comparisons):
  // when the chosen method matches, the caller shows its inline key form.
  const selectedAuthPolicy = registryAgentId ? agentPolicy(registryAgentId).auth : null
  const inlineKeyMethodId =
    selectedAuthPolicy?.mode === 'acp' ? selectedAuthPolicy.inlineKeyFormMethodId : undefined

  // Dispatch an auth method by type: 'agent' (or a missing type — the
  // pre-extension wire only carried agent methods) → provider-owned
  // authenticate; 'terminal' → login terminal tab; anything else ('env_var',
  // 'unknown', future variants) → unsupported. Unknown types are NEVER sent
  // to `authenticate` — the host would reject an id it cannot drive. The
  // inline-key form method (AgentAuthPolicy.inlineKeyFormMethodId) routes to
  // the Factory key form instead of an ACP authenticate round-trip.
  const handleAuthMethod = useCallback(
    (method: AuthMethod) => {
      if (inlineKeyMethodId != null && method.id === inlineKeyMethodId) {
        factoryKeyAuth.requestKeyInput()
      } else if (method.type === 'terminal') {
        void runTerminalAuth(method)
      } else if (method.id === 'gateway') {
        toast.error('Enter the gateway URL in the sign-in banner.')
      } else if (method.type === 'agent' || method.type == null) {
        void runAuthenticate(method.id)
      } else {
        toast.error('This sign-in method is not supported yet.')
      }
    },
    [runTerminalAuth, runAuthenticate, inlineKeyMethodId, factoryKeyAuth]
  )

  const handleSignIn = useCallback(() => {
    if (!signInMethod) {
      toast.error('No sign-in method is available for this agent yet.')
      return
    }
    handleAuthMethod(signInMethod)
  }, [signInMethod, handleAuthMethod])

  return {
    authMethods,
    signInMethod,
    signingInMethodId,
    factoryKeyAuth,
    inlineKeyMethodId,
    handleAuthMethod,
    runAuthenticate,
    handleSignIn
  }
}
