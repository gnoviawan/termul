import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Hoisted mock factories
const { mockIsPermissionGranted, mockRequestPermission, mockSendNotification } = vi.hoisted(
  () => ({
    mockIsPermissionGranted: vi.fn(),
    mockRequestPermission: vi.fn(),
    mockSendNotification: vi.fn()
  })
)

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: mockIsPermissionGranted,
  requestPermission: mockRequestPermission,
  sendNotification: mockSendNotification
}))

const TAURI_KEY = '__TAURI_INTERNALS__'

function setTauriContext(enabled: boolean): void {
  Object.defineProperty(window as unknown as Record<string, unknown>, TAURI_KEY, {
    value: enabled ? {} : undefined,
    configurable: true
  })
}

/**
 * Import a fresh copy of the module so its module-level `permissionGranted` cache
 * starts at `null` for each test (the cache otherwise leaks state across cases).
 */
async function freshSendDesktopNotification(): Promise<
  (title: string, body: string) => Promise<void>
> {
  vi.resetModules()
  const mod = await import('./tauri-notification-api')
  return mod.sendDesktopNotification
}

describe('sendDesktopNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    setTauriContext(false)
  })

  it('skips notification outside Tauri runtime', async () => {
    setTauriContext(false)
    const sendDesktopNotification = await freshSendDesktopNotification()

    await sendDesktopNotification('Project', 'Terminal — DONE')

    expect(mockIsPermissionGranted).not.toHaveBeenCalled()
    expect(mockRequestPermission).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('requests permission then sends when not yet granted in Tauri context', async () => {
    setTauriContext(true)
    mockIsPermissionGranted.mockResolvedValue(false)
    mockRequestPermission.mockResolvedValue('granted')
    const sendDesktopNotification = await freshSendDesktopNotification()

    await sendDesktopNotification('Project', 'Terminal — DONE')

    expect(mockIsPermissionGranted).toHaveBeenCalledTimes(1)
    expect(mockRequestPermission).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).toHaveBeenCalledWith({
      title: 'Project',
      body: 'Terminal — DONE'
    })
  })

  it('sends without requesting permission when already granted', async () => {
    setTauriContext(true)
    mockIsPermissionGranted.mockResolvedValue(true)
    const sendDesktopNotification = await freshSendDesktopNotification()

    await sendDesktopNotification('Project', 'Terminal — DONE')

    expect(mockIsPermissionGranted).toHaveBeenCalledTimes(1)
    expect(mockRequestPermission).not.toHaveBeenCalled()
    expect(mockSendNotification).toHaveBeenCalledWith({
      title: 'Project',
      body: 'Terminal — DONE'
    })
  })

  it('does not send when permission is denied after request', async () => {
    setTauriContext(true)
    mockIsPermissionGranted.mockResolvedValue(false)
    mockRequestPermission.mockResolvedValue('denied')
    const sendDesktopNotification = await freshSendDesktopNotification()

    await sendDesktopNotification('Project', 'Terminal — DONE')

    expect(mockRequestPermission).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })
})
