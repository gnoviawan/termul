/**
 * SSH session orchestration: opens native shell sessions, routes backend
 * progress / host-key / ended events into the SSH store, and owns the
 * terminal-store record each session's terminal is bound to.
 *
 * Kept outside React so sessions survive navigation (switching to a project
 * and back keeps every tab and its live shell).
 */
import type {
  SSHHostKeyPrompt,
  SSHSessionEndedEvent,
  SSHSessionProgressEvent
} from '@shared/types/ssh.types'
import { sshApi, terminalApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { sshTerminalProjectId } from '@/lib/ssh-terminal-id'
import { isTauriContext } from '@/lib/tauri-runtime'
import { randomUUID } from '@/lib/uuid'
import {
  SSH_HOSTS_TAB,
  type SSHCredentialPrompt,
  type SSHSession,
  type SSHSessionError,
  useSSHStore
} from '@/stores/ssh-store'
import { useTerminalStore } from '@/stores/terminal-store'

/** Initial PTY size; the terminal view resizes to its real size on mount. */
const INITIAL_COLS = 120
const INITIAL_ROWS = 32

function findByAttempt(attemptId: string): SSHSession | undefined {
  return useSSHStore.getState().sessions.find((s) => s.attemptId === attemptId)
}

function profileOf(profileId: string) {
  return useSSHStore.getState().profiles.find((p) => p.id === profileId)
}

/** Drop the terminal-store record and the backend terminal of a session. */
function releaseTerminal(session: SSHSession): void {
  if (!session.ptyId) return
  const terminals = useTerminalStore.getState()
  const record = terminals.findTerminalByPtyId(session.ptyId)
  if (record) terminals.closeTerminal(record.id, record.projectId)
  // The backend terminal outlives an ended shell until killed; ignore
  // "not found" for one that is already gone.
  void terminalApi.kill(session.ptyId)
}

/** Which prompt, if any, answers a failed connect. */
export function credentialPromptFor(
  code: string,
  authMethod: string | undefined
): SSHCredentialPrompt | null {
  switch (code) {
    case 'SSH_PASSWORD_REQUIRED':
      return { kind: 'password', reason: 'required' }
    case 'SSH_PASSPHRASE_REQUIRED':
      return { kind: 'passphrase', reason: 'required' }
    case 'SSH_PASSPHRASE_INCORRECT':
      return { kind: 'passphrase', reason: 'rejected' }
    case 'SSH_AUTH_FAILED':
      return authMethod === 'password' ? { kind: 'password', reason: 'rejected' } : null
    default:
      return null
  }
}

interface ConnectOptions {
  /** Password or passphrase typed at a prompt */
  secret?: string
  /** Save `secret` to the OS keychain once it worked */
  saveSecret?: boolean
}

/** Run one connect attempt for an existing tab. */
async function runAttempt(tabId: string, options: ConnectOptions): Promise<void> {
  const store = useSSHStore.getState()
  const session = store.sessions.find((s) => s.id === tabId)
  if (!session) return
  const attemptId = randomUUID()
  store.patchSession(tabId, {
    attemptId,
    status: 'connecting',
    stage: 'connecting',
    hostKeyPrompt: null,
    credentialPrompt: null,
    error: null,
    ended: null,
    ptyId: null,
    claim: null,
    attached: false,
    connectedAt: null
  })

  const result = await sshApi.openSession({
    sessionId: attemptId,
    profileId: session.profileId,
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
    secret: options.secret,
    saveSecret: options.saveSecret
  })

  const current = useSSHStore.getState().sessions.find((s) => s.id === tabId)
  if (!current || current.attemptId !== attemptId) {
    // Tab closed or a newer attempt started meanwhile: drop this shell.
    if (result.success) {
      void sshApi.closeSession(attemptId)
      void terminalApi.kill(result.data.terminal.id)
    }
    return
  }

  if (!result.success) {
    const error: SSHSessionError = { code: result.code ?? 'SSH_INTERNAL', detail: result.error }
    const prompt = credentialPromptFor(error.code, profileOf(session.profileId)?.authMethod)
    void logFrontendError({
      level: error.code === 'SSH_CANCELLED' ? 'info' : 'warn',
      source: 'ssh-sessions.open',
      message: `SSH session for profile ${session.profileId} failed: ${error.code}`
    })
    useSSHStore.getState().patchSession(tabId, {
      status: prompt ? 'awaitingInput' : 'failed',
      stage: null,
      hostKeyPrompt: null,
      credentialPrompt: prompt,
      error
    })
    return
  }

  const { terminal, session: info, secretSaved } = result.data
  const profile = profileOf(session.profileId)
  const terminals = useTerminalStore.getState()
  try {
    // SSH tabs select their terminal themselves; the global active
    // terminal belongs to the workspace panes.
    const record = terminals.addTerminal(
      `SSH: ${profile?.name ?? 'host'}`,
      sshTerminalProjectId(session.profileId),
      terminal.shell,
      terminal.cwd,
      undefined,
      { activate: false }
    )
    terminals.setTerminalPtyId(record.id, terminal.id)
    terminals.setTerminalClaim(terminal.id, terminal.claim)
  } catch (error) {
    // Terminal limit reached: the shell cannot be shown, so close it.
    void sshApi.closeSession(attemptId)
    void terminalApi.kill(terminal.id)
    useSSHStore.getState().patchSession(tabId, {
      status: 'failed',
      stage: null,
      error: {
        code: 'SSH_TERMINAL_LIMIT',
        detail: error instanceof Error ? error.message : String(error)
      }
    })
    return
  }

  // An `ended` event can beat this response for a shell that exits at once;
  // keep that outcome but still show the terminal output.
  const endedEarly = useSSHStore.getState().sessions.find((s) => s.id === tabId)?.ended
  useSSHStore.getState().patchSession(tabId, {
    status: endedEarly ? 'disconnected' : 'connected',
    stage: null,
    ptyId: terminal.id,
    claim: terminal.claim,
    connectedAt: info.connectedAt
  })
  if (secretSaved) void useSSHStore.getState().loadProfiles()
}

/** Open a new session tab for a host and connect it. Returns the tab id. */
export function openSSHSession(profileId: string, options: ConnectOptions = {}): string {
  const tabId = randomUUID()
  const store = useSSHStore.getState()
  store.addSession({
    id: tabId,
    attemptId: tabId,
    profileId,
    status: 'connecting',
    stage: 'connecting',
    hostKeyPrompt: null,
    credentialPrompt: null,
    error: null,
    ended: null,
    ptyId: null,
    claim: null,
    attached: false,
    connectedAt: null
  })
  store.setActiveTab(tabId)
  void runAttempt(tabId, options)
  return tabId
}

/**
 * Connect an existing tab again: after a failure, with a prompt answer, or to
 * reconnect a dropped session (the previous terminal is released).
 */
export function retrySSHSession(tabId: string, options: ConnectOptions = {}): void {
  const session = useSSHStore.getState().sessions.find((s) => s.id === tabId)
  if (!session || session.status === 'connecting' || session.status === 'connected') return
  releaseTerminal(session)
  void runAttempt(tabId, options)
}

/** Answer the host key question of a tab. */
export async function respondSSHHostKey(tabId: string, trust: boolean): Promise<void> {
  const session = useSSHStore.getState().sessions.find((s) => s.id === tabId)
  if (!session?.hostKeyPrompt) return
  useSSHStore.getState().patchSession(tabId, {
    hostKeyPrompt: null,
    status: 'connecting'
  })
  const result = await sshApi.respondHostKey(session.attemptId, trust)
  if (!result.success || !result.data) {
    // The connect already gave up (timeout or cancel); its result follows.
    void logFrontendError({
      level: 'info',
      source: 'ssh-sessions.hostKey',
      message: `Host key answer for ${session.attemptId} arrived after the connect ended`
    })
  }
}

/** Stop a connect in progress; the tab shows the cancelled state. */
export function cancelSSHSession(tabId: string): void {
  const session = useSSHStore.getState().sessions.find((s) => s.id === tabId)
  if (!session) return
  if (session.status === 'connecting' || session.hostKeyPrompt) {
    void sshApi.cancelSession(session.attemptId)
  } else if (session.status === 'awaitingInput') {
    useSSHStore.getState().patchSession(tabId, {
      status: 'failed',
      credentialPrompt: null,
      error: session.error ?? { code: 'SSH_CANCELLED', detail: 'Cancelled' }
    })
  }
}

/** Close a tab and everything it holds (connect, shell, terminal). */
export async function closeSSHSession(tabId: string): Promise<void> {
  const store = useSSHStore.getState()
  const session = store.sessions.find((s) => s.id === tabId)
  if (!session) return
  store.removeSession(tabId)
  if (session.status === 'connecting' || session.status === 'awaitingInput') {
    await sshApi.cancelSession(session.attemptId)
  } else if (session.status === 'connected') {
    await sshApi.closeSession(session.attemptId)
  }
  releaseTerminal(session)
}

/**
 * Close a tab, asking first when its shell is live (a running command would
 * stop). Used by the tab's close button and the close-tab shortcut.
 */
export function requestCloseSSHSession(tabId: string): void {
  const session = useSSHStore.getState().sessions.find((s) => s.id === tabId)
  if (!session) return
  if (session.status === 'connected') useSSHStore.getState().setPendingClose(tabId)
  else void closeSSHSession(tabId)
}

/** Move to the next (1) or previous (-1) SSH workspace tab, wrapping. */
export function cycleSSHTab(direction: 1 | -1): void {
  const { sessions, activeTab, setActiveTab } = useSSHStore.getState()
  const tabs = [SSH_HOSTS_TAB, ...sessions.map((s) => s.id)]
  const index = Math.max(0, tabs.indexOf(activeTab))
  setActiveTab(tabs[(index + direction + tabs.length) % tabs.length])
}

/** Bind the renderer to a session terminal's output (once per terminal). */
export async function attachSSHTerminal(tabId: string): Promise<void> {
  const session = useSSHStore.getState().sessions.find((s) => s.id === tabId)
  if (!session?.ptyId || !session.claim || session.attached) return
  useSSHStore.getState().patchSession(tabId, { attached: true })
  const result = await terminalApi.attach(session.ptyId, session.claim, 0)
  if (!result.success) {
    useSSHStore.getState().patchSession(tabId, { attached: false })
    void logFrontendError({
      level: 'warn',
      source: 'ssh-sessions.attach',
      message: `Could not attach to SSH terminal ${session.ptyId}: ${result.error}`
    })
  }
}

function onProgress(event: SSHSessionProgressEvent): void {
  const session = findByAttempt(event.sessionId)
  if (session?.status !== 'connecting') return
  useSSHStore.getState().patchSession(session.id, { stage: event.stage })
}

function onHostKey(prompt: SSHHostKeyPrompt): void {
  const session = findByAttempt(prompt.sessionId)
  if (!session) {
    // Nobody can answer: reject so the connect fails closed at once.
    void sshApi.respondHostKey(prompt.sessionId, false)
    return
  }
  useSSHStore.getState().patchSession(session.id, {
    status: 'awaitingInput',
    hostKeyPrompt: prompt
  })
}

function onEnded(event: SSHSessionEndedEvent): void {
  const session = findByAttempt(event.sessionId)
  if (!session) return
  useSSHStore.getState().patchSession(session.id, {
    status: 'disconnected',
    ended: { reason: event.reason, exitCode: event.exitCode, detail: event.detail }
  })
  if (event.reason === 'lost') {
    void logFrontendError({
      level: 'warn',
      source: 'ssh-sessions.ended',
      message: `SSH session ${event.sessionId} lost its connection`
    })
  }
}

/** Re-adopt live sessions after a renderer reload. */
async function restoreSessions(): Promise<void> {
  const result = await sshApi.listSessions()
  if (!result.success) return
  const store = useSSHStore.getState()
  for (const live of result.data) {
    if (!live.terminalId || !live.claim) continue
    if (store.sessions.some((s) => s.attemptId === live.sessionId)) continue
    const profile = profileOf(live.profileId)
    const terminals = useTerminalStore.getState()
    if (!terminals.findTerminalByPtyId(live.terminalId)) {
      try {
        const record = terminals.addTerminal(
          `SSH: ${profile?.name ?? 'host'}`,
          sshTerminalProjectId(live.profileId),
          'ssh',
          undefined,
          undefined,
          { activate: false }
        )
        terminals.setTerminalPtyId(record.id, live.terminalId)
      } catch (error) {
        // Terminal limit reached: this shell cannot be shown, so close it and
        // keep restoring the others (as a new session does in this case).
        void logFrontendError({
          level: 'warn',
          source: 'ssh-sessions.restore',
          message: `SSH session for profile ${live.profileId} not restored: ${
            error instanceof Error ? error.message : String(error)
          }`
        })
        void sshApi.closeSession(live.sessionId)
        void terminalApi.kill(live.terminalId)
        continue
      }
    }
    terminals.setTerminalClaim(live.terminalId, live.claim)
    store.addSession({
      id: randomUUID(),
      attemptId: live.sessionId,
      profileId: live.profileId,
      status: 'connected',
      stage: null,
      hostKeyPrompt: null,
      credentialPrompt: null,
      error: null,
      ended: null,
      ptyId: live.terminalId,
      claim: live.claim,
      attached: false,
      connectedAt: live.connectedAt
    })
  }
}

/**
 * Subscribe to backend session events. Desktop only; call
 * once per renderer root. Returns the unsubscribe function.
 */
export function startSSHSessionEvents(): () => void {
  if (!isTauriContext()) return () => {}
  const unsubscribers = [
    sshApi.onSessionProgress(onProgress),
    sshApi.onSessionHostKey(onHostKey),
    sshApi.onSessionEnded(onEnded)
  ]
  void restoreSessions()
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}
