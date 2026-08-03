/**
 * Web-branch tests for tauri-notification-api.ts (CAP-3: Web UI entry parity).
 *
 * `initNotificationPermissions` and `sendDesktopNotification` branch on
 * `isTauriContext()`: desktop calls `@tauri-apps/plugin-notification`
 * (`isPermissionGranted`/`requestPermission`/`sendNotification`); web calls
 * the Web Notifications API (`Notification.requestPermission()` +
 * `new Notification(title, { body })`). This file asserts, per the
 * `log-api.test.ts` dual-branch pattern, that:
 * - the WEB branch calls the Web Notifications API and NOT the Tauri plugin
 * - the DESKTOP branch calls the Tauri plugin and NOT the Web Notifications API
 * - `typeof Notification === 'undefined'` (SSR/test) degrades to a no-op
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockIsPermissionGranted,
  mockRequestPermission,
  mockSendNotification,
  mockIsTauriContext,
  mockNotificationConstructor,
  mockNotificationRequestPermission
} = vi.hoisted(() => ({
  mockIsPermissionGranted: vi.fn(),
  mockRequestPermission: vi.fn(),
  mockSendNotification: vi.fn(),
  mockIsTauriContext: vi.fn(),
  mockNotificationConstructor: vi.fn(),
  mockNotificationRequestPermission: vi.fn()
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: mockIsPermissionGranted,
  requestPermission: mockRequestPermission,
  sendNotification: mockSendNotification
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

// Stub the global `Notification` constructor + static `requestPermission`.
// `permission` is read by `initNotificationPermissions` to short-circuit when
// already granted. We default it to 'default' so each test exercises the
// request path unless it overrides.
const NotificationStub = vi.fn().mockImplementation(mockNotificationConstructor) as unknown as {
  new (title: string, options?: NotificationOptions): Notification
  requestPermission: () => Promise<NotificationPermission>
  permission: NotificationPermission
}
;(NotificationStub as unknown as { requestPermission: typeof vi.fn }).requestPermission =
  mockNotificationRequestPermission
;(NotificationStub as unknown as { permission: NotificationPermission }).permission = 'default'

import {
  _resetNotificationPermissionForTesting,
  initNotificationPermissions,
  sendDesktopNotification
} from '../tauri-notification-api'

describe('tauri-notification-api (web vs desktop branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetNotificationPermissionForTesting()
    mockNotificationRequestPermission.mockResolvedValue('default')
    ;(NotificationStub as unknown as { permission: NotificationPermission }).permission = 'default'
    vi.stubGlobal('Notification', NotificationStub)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('initNotificationPermissions', () => {
    it('web: calls Notification.requestPermission() and maps granted → true', async () => {
      mockIsTauriContext.mockReturnValue(false)
      mockNotificationRequestPermission.mockResolvedValue('granted')

      await initNotificationPermissions()

      expect(mockNotificationRequestPermission).toHaveBeenCalledTimes(1)
      expect(mockIsPermissionGranted).not.toHaveBeenCalled()
      expect(mockRequestPermission).not.toHaveBeenCalled()
    })

    it('web: maps denied → false', async () => {
      mockIsTauriContext.mockReturnValue(false)
      mockNotificationRequestPermission.mockResolvedValue('denied')

      await initNotificationPermissions()

      expect(mockNotificationRequestPermission).toHaveBeenCalledTimes(1)
    })

    it('web: short-circuits when Notification.permission === "granted" (no prompt)', async () => {
      mockIsTauriContext.mockReturnValue(false)
      ;(NotificationStub as unknown as { permission: NotificationPermission }).permission =
        'granted'

      await initNotificationPermissions()

      // Already granted — must not re-prompt.
      expect(mockNotificationRequestPermission).not.toHaveBeenCalled()
    })

    it('web: no-op when typeof Notification === "undefined" (SSR/test)', async () => {
      mockIsTauriContext.mockReturnValue(false)
      vi.unstubAllGlobals() // remove the `Notification` global

      await initNotificationPermissions()

      expect(mockNotificationRequestPermission).not.toHaveBeenCalled()
      expect(mockIsPermissionGranted).not.toHaveBeenCalled()
    })

    it('web: swallows when Notification.requestPermission() throws', async () => {
      mockIsTauriContext.mockReturnValue(false)
      mockNotificationRequestPermission.mockRejectedValue(new Error('blocked'))

      await expect(initNotificationPermissions()).resolves.toBeUndefined()
      expect(mockNotificationRequestPermission).toHaveBeenCalledTimes(1)
    })

    it('web: concurrent calls share one in-flight request (no double prompt)', async () => {
      mockIsTauriContext.mockReturnValue(false)
      let resolveRequest: (value: NotificationPermission) => void = () => {}
      mockNotificationRequestPermission.mockImplementation(
        () =>
          new Promise<NotificationPermission>((resolve) => {
            resolveRequest = resolve
          })
      )

      const first = initNotificationPermissions()
      const second = initNotificationPermissions()

      resolveRequest('granted')
      await Promise.all([first, second])

      expect(mockNotificationRequestPermission).toHaveBeenCalledTimes(1)
    })

    it('desktop: calls isPermissionGranted + requestPermission, maps granted → true', async () => {
      mockIsTauriContext.mockReturnValue(true)
      mockIsPermissionGranted.mockResolvedValue(false)
      mockRequestPermission.mockResolvedValue('granted')

      await initNotificationPermissions()

      expect(mockIsPermissionGranted).toHaveBeenCalledTimes(1)
      expect(mockRequestPermission).toHaveBeenCalledTimes(1)
      expect(mockNotificationRequestPermission).not.toHaveBeenCalled()
    })

    it('desktop: skips request when already granted', async () => {
      mockIsTauriContext.mockReturnValue(true)
      mockIsPermissionGranted.mockResolvedValue(true)

      await initNotificationPermissions()

      expect(mockIsPermissionGranted).toHaveBeenCalledTimes(1)
      expect(mockRequestPermission).not.toHaveBeenCalled()
    })

    it('desktop: never calls the Web Notifications API', async () => {
      mockIsTauriContext.mockReturnValue(true)
      mockIsPermissionGranted.mockResolvedValue(true)

      await initNotificationPermissions()

      expect(mockNotificationRequestPermission).not.toHaveBeenCalled()
      expect(mockNotificationConstructor).not.toHaveBeenCalled()
    })
  })

  describe('sendDesktopNotification', () => {
    it('web: calls new Notification(title, { body }) when permissionGranted', async () => {
      mockIsTauriContext.mockReturnValue(false)
      mockNotificationRequestPermission.mockResolvedValue('granted')
      await initNotificationPermissions()

      await sendDesktopNotification('Project', 'term — DONE')

      expect(mockNotificationConstructor).toHaveBeenCalledTimes(1)
      expect(mockNotificationConstructor).toHaveBeenCalledWith('Project', { body: 'term — DONE' })
      expect(mockSendNotification).not.toHaveBeenCalled()
    })

    it('web: no-op when permission denied (no new Notification)', async () => {
      mockIsTauriContext.mockReturnValue(false)
      mockNotificationRequestPermission.mockResolvedValue('denied')
      await initNotificationPermissions()

      await sendDesktopNotification('Project', 'term — DONE')

      expect(mockNotificationConstructor).not.toHaveBeenCalled()
      expect(mockSendNotification).not.toHaveBeenCalled()
    })

    it('web: lazy-inits permission on first sendDesktopNotification call', async () => {
      mockIsTauriContext.mockReturnValue(false)
      // Do NOT call initNotificationPermissions first — permissionGranted is null.
      mockNotificationRequestPermission.mockResolvedValue('granted')

      await sendDesktopNotification('Project', 'term — DONE')

      expect(mockNotificationRequestPermission).toHaveBeenCalledTimes(1)
      expect(mockNotificationConstructor).toHaveBeenCalledWith('Project', { body: 'term — DONE' })
    })

    it('web: no-op when typeof Notification === "undefined" (SSR/test)', async () => {
      mockIsTauriContext.mockReturnValue(false)
      vi.unstubAllGlobals() // remove the `Notification` global

      await sendDesktopNotification('Project', 'term — DONE')

      expect(mockNotificationConstructor).not.toHaveBeenCalled()
      expect(mockSendNotification).not.toHaveBeenCalled()
    })

    it('web: swallows when new Notification() throws', async () => {
      mockIsTauriContext.mockReturnValue(false)
      mockNotificationRequestPermission.mockResolvedValue('granted')
      await initNotificationPermissions()
      mockNotificationConstructor.mockImplementation(() => {
        throw new Error('notification disabled')
      })

      await expect(sendDesktopNotification('Project', 'term — DONE')).resolves.toBeUndefined()
    })

    it('desktop: calls sendNotification({ title, body }) when permissionGranted', async () => {
      mockIsTauriContext.mockReturnValue(true)
      mockIsPermissionGranted.mockResolvedValue(true)
      await initNotificationPermissions()

      await sendDesktopNotification('Project', 'term — DONE')

      expect(mockSendNotification).toHaveBeenCalledTimes(1)
      expect(mockSendNotification).toHaveBeenCalledWith({
        title: 'Project',
        body: 'term — DONE'
      })
      expect(mockNotificationConstructor).not.toHaveBeenCalled()
    })

    it('desktop: never calls the Web Notifications API', async () => {
      mockIsTauriContext.mockReturnValue(true)
      mockIsPermissionGranted.mockResolvedValue(true)
      await initNotificationPermissions()

      await sendDesktopNotification('Project', 'term — DONE')

      expect(mockNotificationConstructor).not.toHaveBeenCalled()
      expect(mockNotificationRequestPermission).not.toHaveBeenCalled()
    })

    it('desktop: no-op when permission denied', async () => {
      mockIsTauriContext.mockReturnValue(true)
      mockIsPermissionGranted.mockResolvedValue(false)
      mockRequestPermission.mockResolvedValue('denied')
      await initNotificationPermissions()

      await sendDesktopNotification('Project', 'term — DONE')

      expect(mockSendNotification).not.toHaveBeenCalled()
    })
  })
})
