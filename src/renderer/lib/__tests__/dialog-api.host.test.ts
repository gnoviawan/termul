import { afterEach, describe, expect, it, vi } from 'vitest'

const { runtime, mockOpen, mockSave } = vi.hoisted(() => ({
  runtime: { tauri: false },
  mockOpen: vi.fn(),
  mockSave: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({ isTauriContext: () => runtime.tauri }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mockOpen, save: mockSave, confirm: vi.fn() }))

import { pickAttachmentFilesBrowser } from '../composer-attachments-io'
import { _resetDesktopHostForTesting, type DesktopHost, registerDesktopHost } from '../desktop-host'
import { canPickLocalFiles, dialogApi } from '../dialog-api'

function host(overrides: Partial<DesktopHost> = {}): DesktopHost {
  const noop = async () => {}
  return {
    openUrl: noop,
    openPath: noop,
    revealItemInDir: noop,
    notify: noop,
    openFiles: vi.fn(async ({ multiple }) => (multiple ? ['/w/a.txt', '/w/b.png'] : ['/w/key'])),
    saveFile: vi.fn(async ({ defaultPath }) => `/home/me/${defaultPath}`),
    fileAt: (path) => new File(['bytes'], path.split('/').pop() ?? path, { type: 'text/plain' }),
    ...overrides
  }
}

afterEach(() => {
  _resetDesktopHostForTesting()
  runtime.tauri = false
  vi.clearAllMocks()
})

describe('dialogApi with a desktop host', () => {
  it('cannot pick local files on the web until a host registers', () => {
    expect(canPickLocalFiles()).toBe(false)
    registerDesktopHost(host())
    expect(canPickLocalFiles()).toBe(true)
  })

  it('returns the host-picked paths for selectFiles and selectFile', async () => {
    registerDesktopHost(host())
    expect(await dialogApi.selectFiles({ title: 'Upload files' })).toEqual({
      success: true,
      data: ['/w/a.txt', '/w/b.png']
    })
    expect(await dialogApi.selectFile({ title: 'Choose a private key' })).toEqual({
      success: true,
      data: '/w/key'
    })
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('saves to the host-picked path with the suggested name', async () => {
    const dialog = host()
    registerDesktopHost(dialog)
    expect(await dialogApi.saveFile({ title: 'Download', defaultPath: 'app.conf' })).toEqual({
      success: true,
      data: '/home/me/app.conf'
    })
    expect(dialog.saveFile).toHaveBeenCalledWith({ defaultPath: 'app.conf' })
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('reports a dismissed host dialog as cancelled and a failed one as a dialog error', async () => {
    registerDesktopHost(host({ openFiles: async () => null, saveFile: async () => null }))
    expect(await dialogApi.selectFiles()).toEqual({
      success: false,
      error: 'No file selected',
      code: 'CANCELLED'
    })
    expect(await dialogApi.saveFile()).toEqual({
      success: false,
      error: 'No location selected',
      code: 'CANCELLED'
    })
    registerDesktopHost(
      host({
        openFiles: async () => {
          throw new Error('No file picker portal available')
        }
      })
    )
    expect(await dialogApi.selectFile()).toEqual({
      success: false,
      error: 'No file picker portal available',
      code: 'DIALOG_ERROR'
    })
  })

  it('keeps Tauri on its own dialog plugin even with a host registered', async () => {
    runtime.tauri = true
    const dialog = host()
    registerDesktopHost(dialog)
    mockOpen.mockResolvedValue(['/tauri/x'])
    expect(await dialogApi.selectFiles()).toEqual({ success: true, data: ['/tauri/x'] })
    expect(dialog.openFiles).not.toHaveBeenCalled()
  })
})

describe('pickAttachmentFilesBrowser with a desktop host', () => {
  it('returns the picked files as File objects', async () => {
    registerDesktopHost(host())
    const files = await pickAttachmentFilesBrowser()
    expect(files?.map((file) => file.name)).toEqual(['a.txt', 'b.png'])
    expect(files?.map((file) => file.size)).toEqual([5, 5])
  })

  it('returns null when the host dialog is dismissed', async () => {
    registerDesktopHost(host({ openFiles: async () => [] }))
    expect(await pickAttachmentFilesBrowser()).toBeNull()
  })
})
