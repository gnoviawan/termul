import { describe, expect, it, vi } from 'vitest'
import { resolveTerminalWsUrl, WebTerminalClient } from './web-terminal-api'

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.onclose?.()
  }

  reply(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent)
  }
}

describe('WebTerminalClient', () => {
  it('resolves the dedicated same-origin websocket URL', () => {
    expect(resolveTerminalWsUrl({ protocol: 'https:', host: 'termul.test' })).toBe(
      'wss://termul.test/terminal/ws'
    )
  })

  it('maps replies and binary arrays to TerminalApi callbacks', async () => {
    FakeWebSocket.instances = []
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const onData = vi.fn()
    client.onData(onData)
    const pending = client.request<string>('get_cwd', { terminalId: 't1' })
    await vi.waitFor(() => expect(FakeWebSocket.instances[0]?.sent.length).toBe(1))
    const request = JSON.parse(FakeWebSocket.instances[0].sent[0]) as { id: string }
    FakeWebSocket.instances[0].reply({ id: request.id, success: true, data: '/repo' })
    await expect(pending).resolves.toEqual({ success: true, data: '/repo' })

    FakeWebSocket.instances[0].reply({ type: 'data', terminalId: 't1', data: [65, 66] })
    expect(onData).toHaveBeenCalledWith('t1', new Uint8Array([65, 66]))
    client.dispose()
  })
})
