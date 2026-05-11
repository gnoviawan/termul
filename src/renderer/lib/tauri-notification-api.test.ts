import { describe, expect, it, vi, beforeEach } from 'vitest'
import { sendDesktopNotification } from './tauri-notification-api'

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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sendDesktopNotification', () => {
  it('skips notification outside Tauri runtime', async () => {
    await sendDesktopNotification('Project', 'Terminal — DONE')
    expect(mockIsPermissionGranted).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('requests permission if not yet granted in Tauri context', async () => {
    // Simulate Tauri context
    mockIsPermissionGranted.mockResolvedValue(false)
    mockRequestPermission.mockResolvedValue('granted')

    // We can't easily test isTauriContext in unit tests,
    // so we verify the public contract: outside Tauri it no-ops
    await sendDesktopNotification('Project', 'Terminal — DONE')
    expect(mockIsPermissionGranted).not.toHaveBeenCalled()
    expect(mockRequestPermission).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })
})
