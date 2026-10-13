import type {
  SSHHostKeyPrompt,
  SSHProfile,
  SSHSessionEndedEvent,
  SSHSessionProgressEvent
} from '@shared/types/ssh.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTerminalStore } from '@/lib/test-utils/store'
import { mockSpawnedTerminal } from '@/lib/test-utils/terminal'
import { SSH_HOSTS_TAB, useSSHStore } from '@/stores/ssh-store'
import { useTerminalStore } from '@/stores/terminal-store'

const { sshApi, terminalApi, handlers } = vi.hoisted(() => {
  const handlers: {
    progress?: (e: SSHSessionProgressEvent) => void
    hostKey?: (p: SSHHostKeyPrompt) => void
    ended?: (e: SSHSessionEndedEvent) => void
  } = {}
  return {
    handlers,
    sshApi: {
      openSession: vi.fn(),
      respondHostKey: vi.fn(async () => ({ success: true as const, data: true })),
      cancelSession: vi.fn(async () => ({ success: true as const, data: true })),
      closeSession: vi.fn(async () => ({ success: true as const, data: undefined })),
      listSessions: vi.fn(async () => ({ success: true as const, data: [] })),
      listProfiles: vi.fn(async () => ({ success: true as const, data: [] })),
      onSessionProgress: vi.fn((cb) => {
        handlers.progress = cb
        return () => {}
      }),
      onSessionHostKey: vi.fn((cb) => {
        handlers.hostKey = cb
        return () => {}
      }),
      onSessionEnded: vi.fn((cb) => {
        handlers.ended = cb
        return () => {}
      })
    },
    terminalApi: {
      kill: vi.fn(async () => ({ success: true as const, data: undefined })),
      attach: vi.fn(async () => ({ success: true as const, data: {} }))
    }
  }
})

vi.mock('@/lib/api', () => ({ sshApi, terminalApi }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauriContext: () => true
}))

import {
  attachSSHTerminal,
  closeSSHSession,
  credentialPromptFor,
  cycleSSHTab,
  openSSHSession,
  requestCloseSSHSession,
  respondSSHHostKey,
  retrySSHSession,
  startSSHSessionEvents
} from './ssh-sessions'

const profile: SSHProfile = {
  id: 'p1',
  name: 'Web',
  host: 'web.example',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  portForwards: []
}

function opened(sessionId: string, terminalId = 'term-1') {
  return {
    success: true as const,
    data: {
      session: { sessionId, profileId: 'p1', terminalId, connectedAt: '2026-10-12T00:00:00Z' },
      terminal: mockSpawnedTerminal({ id: terminalId, claim: `claim-${terminalId}` }),
      secretSaved: false
    }
  }
}

function failed(code: string, error = 'detail') {
  return { success: false as const, error, code }
}

function session(tabId: string) {
  const found = useSSHStore.getState().sessions.find((s) => s.id === tabId)
  if (!found) throw new Error(`no session ${tabId}`)
  return found
}

/** Let the pending `openSession` promise settle. */
async function settle() {
  await vi.waitFor(() => expect(sshApi.openSession).toHaveBeenCalled())
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  resetTerminalStore()
  useSSHStore.setState({
    profiles: [profile],
    sessions: [],
    workspaceOpen: false,
    activeTab: SSH_HOSTS_TAB,
    selectedProfileId: null,
    pendingClose: null
  })
  startSSHSessionEvents()
})

describe('openSSHSession', () => {
  it('opens a tab, connects it and binds a terminal record', async () => {
    sshApi.openSession.mockImplementation(async ({ sessionId }) => opened(sessionId))
    const tabId = openSSHSession('p1')

    expect(useSSHStore.getState()).toMatchObject({ workspaceOpen: true, activeTab: tabId })
    expect(session(tabId)).toMatchObject({ status: 'connecting', stage: 'connecting' })
    await settle()

    expect(session(tabId)).toMatchObject({
      status: 'connected',
      ptyId: 'term-1',
      claim: 'claim-term-1'
    })
    const record = useTerminalStore.getState().findTerminalByPtyId('term-1')
    expect(record).toMatchObject({ projectId: 'ssh-p1', claim: 'claim-term-1' })
    expect(sshApi.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'p1', sessionId: session(tabId).attemptId })
    )
  })

  it('turns missing and rejected passwords into an inline prompt', async () => {
    sshApi.openSession.mockResolvedValueOnce(failed('SSH_PASSWORD_REQUIRED'))
    const tabId = openSSHSession('p1')
    await settle()
    expect(session(tabId)).toMatchObject({
      status: 'awaitingInput',
      credentialPrompt: { kind: 'password', reason: 'required' }
    })

    sshApi.openSession.mockResolvedValueOnce(failed('SSH_AUTH_FAILED'))
    retrySSHSession(tabId, { secret: 'wrong', saveSecret: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sshApi.openSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ secret: 'wrong', saveSecret: true })
    )
    expect(session(tabId).credentialPrompt).toEqual({ kind: 'password', reason: 'rejected' })
  })

  it('shows other failures with their code and detail', async () => {
    sshApi.openSession.mockResolvedValueOnce(failed('SSH_CONNECTION_REFUSED', 'refused'))
    const tabId = openSSHSession('p1')
    await settle()
    expect(session(tabId)).toMatchObject({
      status: 'failed',
      credentialPrompt: null,
      error: { code: 'SSH_CONNECTION_REFUSED', detail: 'refused' }
    })
  })

  it('reloads profiles when the prompt secret was saved to the keychain', async () => {
    sshApi.openSession.mockImplementation(async ({ sessionId }) => ({
      ...opened(sessionId),
      data: { ...opened(sessionId).data, secretSaved: true }
    }))
    openSSHSession('p1')
    await settle()
    expect(sshApi.listProfiles).toHaveBeenCalled()
  })

  it('drops a shell that arrives after its tab was closed', async () => {
    let resolveOpen: (value: unknown) => void = () => {}
    sshApi.openSession.mockImplementation(
      ({ sessionId }) =>
        new Promise((resolve) => {
          resolveOpen = () => resolve(opened(sessionId, 'late'))
        })
    )
    const tabId = openSSHSession('p1')
    const attemptId = session(tabId).attemptId
    await closeSSHSession(tabId)
    expect(sshApi.cancelSession).toHaveBeenCalledWith(attemptId)

    resolveOpen(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sshApi.closeSession).toHaveBeenCalledWith(attemptId)
    expect(terminalApi.kill).toHaveBeenCalledWith('late')
    expect(useTerminalStore.getState().findTerminalByPtyId('late')).toBeUndefined()
  })
})

describe('backend events', () => {
  it('tracks progress only while connecting', async () => {
    sshApi.openSession.mockReturnValue(new Promise(() => {}))
    const tabId = openSSHSession('p1')
    const attemptId = session(tabId).attemptId
    handlers.progress?.({ sessionId: attemptId, stage: 'authenticating' })
    expect(session(tabId).stage).toBe('authenticating')
    handlers.progress?.({ sessionId: 'someone-else', stage: 'startingShell' })
    expect(session(tabId).stage).toBe('authenticating')
  })

  it('asks about host keys and sends the answer', async () => {
    sshApi.openSession.mockReturnValue(new Promise(() => {}))
    const tabId = openSSHSession('p1')
    const attemptId = session(tabId).attemptId
    const prompt: SSHHostKeyPrompt = {
      sessionId: attemptId,
      status: 'unknown',
      host: 'web.example',
      port: 22,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:abc'
    }
    handlers.hostKey?.(prompt)
    expect(session(tabId)).toMatchObject({ status: 'awaitingInput', hostKeyPrompt: prompt })

    await respondSSHHostKey(tabId, true)
    expect(sshApi.respondHostKey).toHaveBeenCalledWith(attemptId, true)
    expect(session(tabId)).toMatchObject({ status: 'connecting', hostKeyPrompt: null })
  })

  it('rejects host-key questions nobody can answer', () => {
    handlers.hostKey?.({
      sessionId: 'orphan',
      status: 'changed',
      host: 'h',
      port: 22,
      keyType: 'ssh-rsa',
      fingerprint: 'SHA256:x'
    })
    expect(sshApi.respondHostKey).toHaveBeenCalledWith('orphan', false)
  })

  it('keeps the terminal and marks the tab disconnected when the shell ends', async () => {
    sshApi.openSession.mockImplementation(async ({ sessionId }) => opened(sessionId))
    const tabId = openSSHSession('p1')
    await settle()
    handlers.ended?.({
      sessionId: session(tabId).attemptId,
      terminalId: 'term-1',
      reason: 'lost',
      exitCode: null,
      detail: 'Keepalive timeout'
    })
    expect(session(tabId)).toMatchObject({
      status: 'disconnected',
      ptyId: 'term-1',
      ended: { reason: 'lost', exitCode: null, detail: 'Keepalive timeout' }
    })
  })

  it('stays disconnected when the end arrives before the open result', async () => {
    let resolveOpen: () => void = () => {}
    sshApi.openSession.mockImplementation(
      ({ sessionId }) =>
        new Promise((resolve) => {
          resolveOpen = () => resolve(opened(sessionId))
        })
    )
    const tabId = openSSHSession('p1')
    handlers.ended?.({
      sessionId: session(tabId).attemptId,
      terminalId: null,
      reason: 'exited',
      exitCode: 0,
      detail: null
    })
    resolveOpen()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(session(tabId)).toMatchObject({ status: 'disconnected', ptyId: 'term-1' })
  })
})

describe('reconnect, close and tabs', () => {
  it('reconnects a dropped tab with a fresh attempt and terminal', async () => {
    sshApi.openSession.mockImplementation(async ({ sessionId }) =>
      opened(sessionId, `t-${sessionId}`)
    )
    const tabId = openSSHSession('p1')
    await settle()
    const first = session(tabId)
    handlers.ended?.({
      sessionId: first.attemptId,
      terminalId: first.ptyId,
      reason: 'lost',
      exitCode: null,
      detail: null
    })

    retrySSHSession(tabId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = session(tabId)
    expect(second.attemptId).not.toBe(first.attemptId)
    expect(second).toMatchObject({ status: 'connected', ended: null })
    expect(terminalApi.kill).toHaveBeenCalledWith(first.ptyId)
    expect(useTerminalStore.getState().findTerminalByPtyId(first.ptyId as string)).toBeUndefined()
  })

  it('does not reconnect a tab that is connected or connecting', async () => {
    sshApi.openSession.mockImplementation(async ({ sessionId }) => opened(sessionId))
    const tabId = openSSHSession('p1')
    await settle()
    retrySSHSession(tabId)
    expect(sshApi.openSession).toHaveBeenCalledTimes(1)
  })

  it('asks before closing a live session, closes others at once', async () => {
    sshApi.openSession.mockImplementationOnce(async ({ sessionId }) => opened(sessionId))
    const live = openSSHSession('p1')
    await settle()
    requestCloseSSHSession(live)
    expect(useSSHStore.getState().pendingClose).toBe(live)
    expect(sshApi.closeSession).not.toHaveBeenCalled()

    sshApi.openSession.mockResolvedValueOnce(failed('SSH_TIMEOUT'))
    const dead = openSSHSession('p1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    requestCloseSSHSession(dead)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useSSHStore.getState().sessions.map((s) => s.id)).toEqual([live])
  })

  it('closes a live session, its terminal and focuses the neighbour tab', async () => {
    sshApi.openSession.mockImplementation(async ({ sessionId }) =>
      opened(sessionId, `t-${sessionId}`)
    )
    const a = openSSHSession('p1')
    const b = openSSHSession('p1')
    await settle()
    useSSHStore.getState().setActiveTab(a)
    const ptyId = session(a).ptyId as string
    await closeSSHSession(a)
    expect(sshApi.closeSession).toHaveBeenCalled()
    expect(terminalApi.kill).toHaveBeenCalledWith(ptyId)
    expect(useSSHStore.getState().activeTab).toBe(b)
  })

  it('cycles through Hosts and session tabs', () => {
    sshApi.openSession.mockReturnValue(new Promise(() => {}))
    const a = openSSHSession('p1')
    const b = openSSHSession('p1')
    cycleSSHTab(1)
    expect(useSSHStore.getState().activeTab).toBe(SSH_HOSTS_TAB)
    cycleSSHTab(1)
    expect(useSSHStore.getState().activeTab).toBe(a)
    cycleSSHTab(-1)
    cycleSSHTab(-1)
    expect(useSSHStore.getState().activeTab).toBe(b)
  })

  it('attaches to a session terminal once', async () => {
    sshApi.openSession.mockImplementation(async ({ sessionId }) => opened(sessionId))
    const tabId = openSSHSession('p1')
    await settle()
    await attachSSHTerminal(tabId)
    await attachSSHTerminal(tabId)
    expect(terminalApi.attach).toHaveBeenCalledTimes(1)
    expect(terminalApi.attach).toHaveBeenCalledWith('term-1', 'claim-term-1', 0)
  })
})

describe('restore after reload', () => {
  it('re-adopts live backend sessions once', async () => {
    sshApi.listSessions.mockResolvedValue({
      success: true,
      data: [
        {
          sessionId: 'backend-1',
          profileId: 'p1',
          terminalId: 'term-9',
          connectedAt: '2026-10-12T00:00:00Z',
          claim: 'fresh'
        }
      ]
    } as never)
    startSSHSessionEvents()
    await vi.waitFor(() => expect(useSSHStore.getState().sessions).toHaveLength(1))
    startSSHSessionEvents()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useSSHStore.getState().sessions).toHaveLength(1)
    expect(useSSHStore.getState().sessions[0]).toMatchObject({
      attemptId: 'backend-1',
      status: 'connected',
      ptyId: 'term-9',
      claim: 'fresh'
    })
  })
})

describe('credentialPromptFor', () => {
  it('maps codes to prompts', () => {
    expect(credentialPromptFor('SSH_PASSPHRASE_REQUIRED', 'key')).toEqual({
      kind: 'passphrase',
      reason: 'required'
    })
    expect(credentialPromptFor('SSH_PASSPHRASE_INCORRECT', 'key')).toEqual({
      kind: 'passphrase',
      reason: 'rejected'
    })
    expect(credentialPromptFor('SSH_AUTH_FAILED', 'key')).toBeNull()
    expect(credentialPromptFor('SSH_TIMEOUT', 'password')).toBeNull()
  })
})
