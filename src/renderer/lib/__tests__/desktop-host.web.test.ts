/**
 * The desktop host seam on the non-Tauri branch of the opener and
 * notification facades: a registered host (the GPUIX client) gets the OS
 * call, a host failure maps to the facade's existing error code, and with no
 * host the browser behavior is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsTauriContext, mockLogFrontendError } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(() => false),
  mockLogFrontendError: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({ isTauriContext: mockIsTauriContext }))
vi.mock('../log-api', () => ({ logFrontendError: mockLogFrontendError }))

import { _resetDesktopHostForTesting, type DesktopHost, registerDesktopHost } from '../desktop-host'
import {
  _resetNotificationPermissionForTesting,
  sendDesktopNotification
} from '../tauri-notification-api'
import { openerApi } from '../tauri-opener-api'

function recordingHost(fail = false): { host: DesktopHost; calls: string[] } {
  const calls: string[] = []
  const record =
    (name: string) =>
    async (...args: string[]) => {
      calls.push(`${name}(${args.join(', ')})`)
      if (fail) throw new Error(`${name} failed`)
    }
  return {
    calls,
    host: {
      openUrl: record('openUrl'),
      openPath: record('openPath'),
      revealItemInDir: record('revealItemInDir'),
      notify: record('notify'),
      openFiles: async () => null,
      saveFile: async () => null,
      fileAt: (path) => new File([], path)
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsTauriContext.mockReturnValue(false)
  _resetDesktopHostForTesting()
  _resetNotificationPermissionForTesting()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('opener facade with a desktop host', () => {
  it('routes all three openers to the host', async () => {
    const { host, calls } = recordingHost()
    registerDesktopHost(host)

    expect(await openerApi.openUrlWithSystemBrowser('https://termul.dev/a')).toEqual({
      success: true,
      data: undefined
    })
    expect(await openerApi.openWithExternalApp('/work/readme.md')).toEqual({
      success: true,
      data: undefined
    })
    expect(await openerApi.revealInFileManager('/work/src')).toEqual({
      success: true,
      data: undefined
    })
    expect(calls).toEqual([
      'openUrl(https://termul.dev/a)',
      'openPath(/work/readme.md)',
      'revealItemInDir(/work/src)'
    ])
  })

  it('maps a host failure to the existing error codes', async () => {
    registerDesktopHost(recordingHost(true).host)

    expect(await openerApi.openUrlWithSystemBrowser('https://termul.dev/a')).toEqual({
      success: false,
      error: 'openUrl failed',
      code: 'OPEN_URL_ERROR'
    })
    expect(await openerApi.openWithExternalApp('/x')).toEqual({
      success: false,
      error: 'openPath failed',
      code: 'OPEN_ERROR'
    })
    expect(await openerApi.revealInFileManager('/x')).toEqual({
      success: false,
      error: 'revealItemInDir failed',
      code: 'REVEAL_ERROR'
    })
  })

  it('keeps the scheme guard: a javascript: URL never reaches the host', async () => {
    const { host, calls } = recordingHost()
    registerDesktopHost(host)

    expect(await openerApi.openUrlWithSystemBrowser('javascript:alert(1)')).toEqual({
      success: true,
      data: undefined
    })
    await openerApi.openUrlWithSystemBrowser('mailto:dev@termul.dev')
    expect(calls).toEqual(['openUrl(mailto:dev@termul.dev)'])
  })

  it('without a host the web results are unchanged', async () => {
    const windowOpen = vi.fn(() => ({ opener: {} }))
    vi.stubGlobal('open', windowOpen)

    expect(await openerApi.revealInFileManager('/x')).toEqual({
      success: false,
      error: 'Revealing in file manager is not available in the web client',
      code: 'WEB_UNSUPPORTED'
    })
    expect(await openerApi.openWithExternalApp('/x')).toEqual({
      success: false,
      error: 'Opening with external apps is not available in the web client',
      code: 'WEB_UNSUPPORTED'
    })
    expect(await openerApi.openUrlWithSystemBrowser('https://termul.dev/a')).toEqual({
      success: true,
      data: undefined
    })
    expect(windowOpen).toHaveBeenCalledWith('https://termul.dev/a', '_blank')
  })
})

describe('notification facade with a desktop host', () => {
  it('sends through the host without a permission prompt', async () => {
    const requestPermission = vi.fn(async () => 'granted')
    const constructed: string[] = []
    vi.stubGlobal(
      'Notification',
      Object.assign(
        function Notification(title: string) {
          constructed.push(title)
        },
        { permission: 'default', requestPermission }
      )
    )
    const { host, calls } = recordingHost()
    registerDesktopHost(host)

    await sendDesktopNotification('termul', 'Terminal 2 exited')

    expect(calls).toEqual(['notify(termul, Terminal 2 exited)'])
    expect(constructed).toEqual([])
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('logs a host failure instead of throwing', async () => {
    registerDesktopHost(recordingHost(true).host)

    await sendDesktopNotification('termul', 'done')

    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: 'notify failed',
        source: 'tauri-notification-api:desktop-host'
      })
    )
  })

  it('without a host and without Notification it stays a no-op', async () => {
    await expect(sendDesktopNotification('termul', 'done')).resolves.toBeUndefined()
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })
})
