import { terminalApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { openTerminalAtCwd } from '@/lib/terminal-spawn'
import { useTerminalStore } from '@/stores/terminal-store'

/** How long to wait for the new shell's first output before typing anyway. */
const SHELL_READY_TIMEOUT_MS = 1500

// biome-ignore lint/suspicious/noControlCharactersInRegex: the guard is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** Resolve once the PTY prints anything (its prompt), or after the timeout. */
function shellReady(ptyId: string): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null
    const done = (): void => {
      clearTimeout(timer)
      unsubscribe?.()
      resolve()
    }
    const timer = setTimeout(done, SHELL_READY_TIMEOUT_MS)
    unsubscribe = terminalApi.onData((terminalId) => {
      if (terminalId === ptyId) done()
    })
  })
}

/**
 * CAP-1 sign-in: open a terminal tab in the active pane at `cwd` and run the
 * host's `gh auth login` command in its shell. The spawn and the write go
 * through `terminalApi`, so the same path drives the desktop PTY and the
 * host's PTY from the web client. The command is typed into the user's shell
 * rather than spawned as the program, so the tab stays a normal shell after
 * `gh` exits. Returns false when the terminal could not be opened.
 */
export async function openGithubSignInTerminal(
  projectId: string,
  cwd: string,
  loginCommand: string
): Promise<boolean> {
  if (!loginCommand.trim() || CONTROL_CHARS.test(loginCommand)) {
    void logFrontendError({
      level: 'warn',
      source: 'github-sign-in',
      message: 'Refused a GitHub login command that is empty or carries control characters'
    })
    return false
  }

  const outcome = await openTerminalAtCwd(projectId, cwd, { name: 'GitHub sign-in' })
  if (outcome.status !== 'opened' || !outcome.terminalId) return false

  const ptyId = useTerminalStore
    .getState()
    .terminals.find((terminal) => terminal.id === outcome.terminalId)?.ptyId
  if (!ptyId) {
    void logFrontendError({
      level: 'warn',
      source: 'github-sign-in',
      message: `Sign-in terminal has no PTY id (terminalId=${outcome.terminalId})`
    })
    return false
  }

  await shellReady(ptyId)
  const written = await terminalApi.write(ptyId, `${loginCommand}\r`)
  if (!written.success) {
    void logFrontendError({
      level: 'error',
      source: 'github-sign-in',
      message: `Could not type the login command (code=${written.code})`
    })
    return false
  }
  return true
}
