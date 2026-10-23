/**
 * The `/ws` host-local requests (Claude Account management, SSH) and the
 * connection capabilities the host reports on `authenticate`, against a fake
 * host.
 */
import { WS_REQUEST_TYPES } from '@shared/types/web-protocol.types'
import { afterEach, describe, expect, it } from 'vitest'
import { WsAcpTransport } from './ws-transport'

interface Frame {
  id: string
  type: string
  payload: Record<string, unknown>
  command_id?: string
}

const REPLIES: Record<string, unknown> = {
  add_claude_account: { id: 'ab12', name: 'Work', createdAt: 1 },
  login_claude_account: {},
  cancel_claude_account_login: { cancelled: true },
  rename_claude_account: {},
  remove_claude_account: { movedProjectIds: ['office'] }
}

class FakeHost {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static capabilities: unknown = { write: true, hostLocal: true }
  static last: FakeHost | null = null

  readyState = FakeHost.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  frames: Frame[] = []

  constructor(public url: string) {
    FakeHost.last = this
    queueMicrotask(() => {
      this.readyState = FakeHost.OPEN
      this.onopen?.(new Event('open'))
      this.emit({ sid: null, seq: 0, type: 'auth_required', payload: {} })
    })
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame
    this.frames.push(frame)
    const payload =
      frame.type === 'authenticate'
        ? { historyMode: 'server', capabilities: FakeHost.capabilities }
        : (REPLIES[frame.type] ?? {})
    queueMicrotask(() => this.emit({ id: frame.id, ok: true, payload }))
  }

  close(): void {
    this.readyState = FakeHost.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  emit(obj: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(obj) }))
  }
}

function transport(): WsAcpTransport {
  return new WsAcpTransport({
    url: 'ws://test/ws',
    WebSocketImpl: FakeHost as unknown as typeof WebSocket
  })
}

afterEach(() => {
  FakeHost.capabilities = { write: true, hostLocal: true }
})

describe('connection capabilities', () => {
  it('are null before the handshake and the host grant after it', async () => {
    const t = transport()
    expect(t.connectionCapabilities()).toBeNull()
    await t.connect()
    expect(t.connectionCapabilities()).toEqual({ write: true, hostLocal: true })
    t.dispose()
  })

  it('grant nothing when an older host omits them', async () => {
    FakeHost.capabilities = undefined
    const t = transport()
    await t.connect()
    expect(t.connectionCapabilities()).toEqual({ write: false, hostLocal: false })
    t.dispose()
  })
})

describe('Claude Account management over /ws', () => {
  it('sends each request with its payload and maps each reply', async () => {
    const t = transport()
    await t.connect()
    await expect(t.addClaudeAccount('Work')).resolves.toEqual({
      id: 'ab12',
      name: 'Work',
      createdAt: 1
    })
    await expect(t.loginClaudeAccount('ab12')).resolves.toBeUndefined()
    await expect(t.cancelClaudeAccountLogin('ab12')).resolves.toBe(true)
    await expect(t.renameClaudeAccount('ab12', 'Office')).resolves.toBeUndefined()
    await expect(t.removeClaudeAccount('ab12')).resolves.toEqual(['office'])
    const sent = FakeHost.last?.frames.filter((f) => f.type in REPLIES) ?? []
    expect(sent.map((f) => [f.type, f.payload])).toEqual([
      ['add_claude_account', { name: 'Work' }],
      ['login_claude_account', { accountId: 'ab12' }],
      ['cancel_claude_account_login', { accountId: 'ab12' }],
      ['rename_claude_account', { accountId: 'ab12', name: 'Office' }],
      ['remove_claude_account', { accountId: 'ab12' }]
    ])
    // The host ledgers add and login, so each carries a fresh commandId.
    const ids = sent.map((f) => f.command_id)
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(ids[1]).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(ids[0]).not.toBe(ids[1])
    expect(ids.slice(2)).toEqual([undefined, undefined, undefined])
    t.dispose()
  })
})

describe('SSH over /ws', () => {
  it('stamps a commandId on exactly the requests the host ledgers', async () => {
    const t = transport()
    await t.connect()
    const ssh = WS_REQUEST_TYPES.filter((type) => /^(ssh|sftp)_/.test(type))
    for (const type of ssh) await t.sshRequest(type as Parameters<typeof t.sshRequest>[0], {})
    const stamped = (FakeHost.last?.frames ?? [])
      .filter((f) => ssh.includes(f.type as (typeof ssh)[number]))
      .filter((f) => f.command_id !== undefined)
    expect(stamped.map((f) => f.type)).toEqual([
      'ssh_duplicate_profile',
      'ssh_import_config',
      'ssh_session_open'
    ])
    for (const f of stamped) expect(f.command_id).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    t.dispose()
  })
})
