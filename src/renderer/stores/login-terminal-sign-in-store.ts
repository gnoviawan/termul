import { toast } from 'sonner'
import { create } from 'zustand'
import { logFrontendError } from '@/lib/log-api'
import { terminalApi } from '@/lib/terminal-api'
import { useAcpStore } from '@/stores/acp-store'

/**
 * A terminal sign-in method's login terminal, from the press until its
 * process exits (spec-acp-terminal-auth). Kept here, not in the component
 * that pressed it: the model selector popover and the phone setup sheet can
 * close while the login still runs, and its exit must still sign the agent in
 * (issue #1648).
 */
export interface LoginTerminalSignIn {
  /** The live agent that advertised the method. */
  agentId: string
  methodId: string
  agentName: string
  /** The login terminal's PTY; null while it is still spawning. */
  ptyId: string | null
}

interface LoginTerminalSignInState {
  /** Running terminal sign-ins by live agent id: one per agent at a time. */
  byAgent: Record<string, LoginTerminalSignIn>
}

export const useLoginTerminalSignInStore = create<LoginTerminalSignInState>(() => ({
  byAgent: {}
}))

/** Controls for one running terminal sign-in, returned by {@link beginLoginTerminalSignIn}. */
export interface LoginTerminalWatch {
  /** The login terminal spawned: watch its PTY and handle an exit that already happened. */
  attach: (ptyId: string) => Promise<void>
  /** The login terminal never opened: forget the sign-in without running it. */
  abandon: () => void
}

const SOURCE = 'agentSignIn.loginTerminal'

/**
 * Start watching a login terminal for one agent. The exit listener is
 * registered before the caller spawns the terminal, so an exit that lands
 * while the spawn is in flight is buffered by PTY id and handled by
 * `attach`; `attach` then polls the recorded exit code once for an exit
 * before the listener attached.
 *
 * Exit 0 runs the ACP `authenticate` and then `onSignedIn` (re-prepare, read
 * the models again) whether or not the surface that started it is still
 * mounted, so `onSignedIn` must only reach stores. Any other exit code shows
 * a toast. Returns null when a sign-in for this agent is already running, so
 * a second press, from any surface, never opens a second login terminal.
 */
export function beginLoginTerminalSignIn(opts: {
  agentId: string
  methodId: string
  agentName: string
  onSignedIn: () => void
}): LoginTerminalWatch | null {
  const { agentId, methodId, agentName, onSignedIn } = opts
  if (useLoginTerminalSignInStore.getState().byAgent[agentId]) {
    void logFrontendError({
      level: 'info',
      source: SOURCE,
      message: `A login terminal for ${agentId} is already open; not opening another`
    })
    return null
  }

  let entry: LoginTerminalSignIn = { agentId, methodId, agentName, ptyId: null }
  let done = false
  // Exits seen while the spawn is in flight, before `attach` names our PTY.
  const earlyExits = new Map<string, number>()
  const unlisten = terminalApi.onExit((id, exitCode) => {
    if (entry.ptyId === null) {
      if (!done) earlyExits.set(id, exitCode)
      return
    }
    if (id !== entry.ptyId) return
    handleExit(exitCode)
  })

  const put = (next: LoginTerminalSignIn): void => {
    entry = next
    useLoginTerminalSignInStore.setState((s) => ({ byAgent: { ...s.byAgent, [agentId]: next } }))
  }
  const finish = (): void => {
    done = true
    unlisten()
    earlyExits.clear()
    useLoginTerminalSignInStore.setState((s) => {
      // Only drop this sign-in's own record.
      if (s.byAgent[agentId] !== entry) return s
      const { [agentId]: _finished, ...rest } = s.byAgent
      return { byAgent: rest }
    })
  }
  // The listener and the post-spawn exit-code poll can both observe the same
  // exit: handle it once.
  function handleExit(exitCode: number): void {
    if (done) return
    finish()
    void logFrontendError({
      level: exitCode === 0 ? 'info' : 'warn',
      source: SOURCE,
      message: `Login terminal ${entry.ptyId} for ${agentId} ('${methodId}') exited with code ${exitCode}`
    })
    if (exitCode !== 0) {
      toast.error(`${agentName} sign-in exited with code ${exitCode}.`)
      return
    }
    // The login TUI writes credentials itself, so `authenticate` typically
    // returns at once; it also covers agents that gate on the explicit call.
    // `authenticateAgent` shares the in-flight dedup and marks the agent
    // authenticated so `createSession` skips its own authenticate. Re-prepare
    // whatever its outcome: the credentials are already written.
    void useAcpStore
      .getState()
      .authenticateAgent(agentId, methodId)
      .catch((err: unknown) => {
        // A fixed message: the raw error can echo a token.
        void logFrontendError({
          level: 'warn',
          source: SOURCE,
          message: `authenticate after the login terminal failed for ${agentId}`
        })
        toast.error(err instanceof Error ? err.message : 'Sign-in failed')
      })
      .finally(() => onSignedIn())
  }

  put(entry)
  void logFrontendError({
    level: 'info',
    source: SOURCE,
    message: `Opening a login terminal for ${agentId} with method '${methodId}'`
  })

  return {
    attach: async (ptyId) => {
      if (done) return
      put({ ...entry, ptyId })
      const earlyExit = earlyExits.get(ptyId)
      earlyExits.clear()
      if (earlyExit !== undefined) {
        handleExit(earlyExit)
        return
      }
      const exitResult = await terminalApi.getExitCode(ptyId)
      if (exitResult.success && exitResult.data !== null) handleExit(exitResult.data)
    },
    abandon: () => {
      if (done) return
      finish()
      void logFrontendError({
        level: 'warn',
        source: SOURCE,
        message: `Login terminal for ${agentId} ('${methodId}') did not open`
      })
    }
  }
}
