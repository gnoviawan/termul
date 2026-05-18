import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

async function mockTermulWebSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Listener = (event?: unknown) => void

    class MockWebSocket {
      static OPEN = 1
      static CLOSED = 3

      url: string
      readyState = 0
      onopen: Listener | null = null
      onmessage: Listener | null = null
      onclose: Listener | null = null
      onerror: Listener | null = null
      sentMessages: string[] = []
      private authDone = false
      private terminalId = 'pw-terminal-1'

      constructor(url: string) {
        this.url = url
        ;(window as Window & { __TERMUL_MOCK_SOCKETS__?: MockWebSocket[] }).__TERMUL_MOCK_SOCKETS__ ??= []
        ;(window as Window & { __TERMUL_MOCK_SOCKETS__?: MockWebSocket[] }).__TERMUL_MOCK_SOCKETS__?.push(this)

        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN
          this.onopen?.({ target: this })
        }, 0)
      }

      send(raw: string): void {
        this.sentMessages.push(raw)
        const message = JSON.parse(raw) as {
          type: string
          id?: string
          token?: string
          method?: string
          params?: Record<string, unknown>
        }

        if (message.type === 'auth') {
          this.authDone = true
          this.emit({
            type: 'response',
            id: 'auth',
            success: message.token === 'playwright-test-token',
            error: message.token === 'playwright-test-token' ? undefined : 'Authentication failed',
          })
          return
        }

        if (!this.authDone || message.type !== 'request' || !message.id || !message.method) {
          return
        }

        if (message.method === 'terminal_spawn') {
          this.emit({
            type: 'response',
            id: message.id,
            success: true,
            data: { id: this.terminalId, shell: 'pwsh', cwd: '/workspace' },
          })

          setTimeout(() => {
            this.emit({
              type: 'event',
              event: 'terminal-data',
              payload: { terminalId: this.terminalId, data: 'Termul mock ready\\r\\n$ ' },
            })
          }, 10)
          return
        }

        if (message.method === 'terminal_write') {
          const data = String(message.params?.data ?? '')
          this.emit({ type: 'response', id: message.id, success: true, data: null })

          if (data.includes('echo hello from playwright')) {
            setTimeout(() => {
              this.emit({
                type: 'event',
                event: 'terminal-data',
                payload: {
                  terminalId: this.terminalId,
                  data: `echo hello from playwright\\r\\nhello from playwright\\r\\n$ `,
                },
              })
            }, 10)
          }
          return
        }

        if (message.method === 'terminal_resize') {
          this.emit({ type: 'response', id: message.id, success: true, data: null })
          return
        }

        this.emit({ type: 'response', id: message.id, success: true, data: null })
      }

      close(): void {
        this.readyState = MockWebSocket.CLOSED
        this.onclose?.({ target: this })
      }

      private emit(message: unknown): void {
        this.onmessage?.({ data: JSON.stringify(message) })
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    })
  })
}

test.describe('Termul web terminal e2e', () => {
  test('connects, shows desktop-like shell, writes command, renders output', async ({ page }) => {
    await mockTermulWebSocket(page)
    await page.goto('/')

    await expect(page.getByText('Termul Web')).toBeVisible()
    await expect(page.getByText('Connected')).toBeVisible()
    await expect(page.locator('.xterm')).toBeVisible()
    await expect(page.locator('.xterm-rows')).toContainText('Termul mock ready')

    await page.locator('.xterm textarea').focus()
    await page.keyboard.type('echo hello from playwright')
    await page.keyboard.press('Enter')

    await expect(page.locator('.xterm-rows')).toContainText('hello from playwright')

    const sent = await page.evaluate(() => {
      const sockets = (window as Window & { __TERMUL_MOCK_SOCKETS__?: Array<{ sentMessages: string[] }> }).__TERMUL_MOCK_SOCKETS__ ?? []
      return sockets.flatMap((socket) => socket.sentMessages)
    })

    expect(sent.some((raw) => raw.includes('"method":"terminal_spawn"'))).toBeTruthy()
    expect(sent.some((raw) => raw.includes('"method":"terminal_write"') && raw.includes('echo hello from playwright'))).toBeTruthy()
  })

  test('shows connection error state when auth fails', async ({ page }) => {
    await page.addInitScript(() => {
      class FailingWebSocket {
        static OPEN = 1
        url: string
        readyState = 0
        onopen: ((event?: unknown) => void) | null = null
        onmessage: ((event?: unknown) => void) | null = null
        onclose: ((event?: unknown) => void) | null = null
        onerror: ((event?: unknown) => void) | null = null

        constructor(url: string) {
          this.url = url
          setTimeout(() => {
            this.readyState = FailingWebSocket.OPEN
            this.onopen?.({ target: this })
          }, 0)
        }

        send(raw: string): void {
          const message = JSON.parse(raw) as { type: string }
          if (message.type === 'auth') {
            this.onmessage?.({
              data: JSON.stringify({ type: 'response', id: 'auth', success: false, error: 'Authentication failed' }),
            })
            this.onclose?.({ target: this })
          }
        }

        close(): void {
          this.onclose?.({ target: this })
        }
      }

      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: FailingWebSocket,
      })
    })

    await page.goto('/')

    await expect(page.getByText('Connection Lost')).toBeVisible()
    await expect(page.getByText(/Authentication failed/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry Connection' })).toBeVisible()
  })
})
