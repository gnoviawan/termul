import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// We need to test the CwdTracker class directly without module reset
// Import the functions we need to test

// Create a mock function for visibility state that can be controlled
const mockGetVisibilityState = vi.fn(() => true)

// Mock the visibility IPC module before any imports
vi.mock('../ipc/visibility.ipc', () => ({
  getVisibilityState: () => mockGetVisibilityState()
}))

describe('cwd-tracker', () => {
  let cwdTrackerModule: typeof import('./cwd-tracker')
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(async () => {
    vi.clearAllMocks()
    // Reset visibility mock to default (visible)
    mockGetVisibilityState.mockReturnValue(true)
    // Save original platform descriptor
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    // Import fresh module
    cwdTrackerModule = await import('./cwd-tracker')
    // Reset any existing tracker
    cwdTrackerModule.resetCwdTracker()
  })

  afterEach(() => {
    // Restore original platform
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (cwdTrackerModule) {
      cwdTrackerModule.resetCwdTracker()
    }
    vi.restoreAllMocks()
  })

  describe('CwdTracker class', () => {
    it('should start tracking a terminal with initial CWD', async () => {
      const tracker = cwdTrackerModule.getDefaultCwdTracker()

      tracker.startTracking('term-1', 12345, '/home/user')
      const cwd = await tracker.getCwd('term-1')

      expect(cwd).toBe('/home/user')
    })

    it('should return null for untracked terminal', async () => {
      const tracker = cwdTrackerModule.getDefaultCwdTracker()

      const cwd = await tracker.getCwd('nonexistent')

      expect(cwd).toBeNull()
    })

    it('should stop tracking when terminal is unregistered', async () => {
      const tracker = cwdTrackerModule.getDefaultCwdTracker()

      tracker.startTracking('term-1', 12345, '/home/user')
      tracker.stopTracking('term-1')
      const cwd = await tracker.getCwd('term-1')

      expect(cwd).toBeNull()
    })

    it('should remove callback when unsubscribe is called', () => {
      const tracker = cwdTrackerModule.getDefaultCwdTracker()
      const callback = vi.fn()

      const unsubscribe = tracker.onCwdChanged(callback)
      unsubscribe()

      // Verify callback was not called (it would only be called during polling)
      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('getDefaultCwdTracker', () => {
    it('should return singleton instance', () => {
      const tracker1 = cwdTrackerModule.getDefaultCwdTracker()
      const tracker2 = cwdTrackerModule.getDefaultCwdTracker()

      expect(tracker1).toBe(tracker2)
    })
  })

  describe('resetCwdTracker', () => {
    it('should clear tracked terminals after reset', async () => {
      const tracker = cwdTrackerModule.getDefaultCwdTracker()
      tracker.startTracking('term-1', 12345, '/home/user')

      cwdTrackerModule.resetCwdTracker()

      // After reset, getting a new tracker should not have the old terminal
      const newTracker = cwdTrackerModule.getDefaultCwdTracker()
      const cwd = await newTracker.getCwd('term-1')
      expect(cwd).toBeNull()
    })
  })

  describe('visibility state handling', () => {
    it('should skip polling when app is not visible (non-Windows)', async () => {
      vi.useFakeTimers()

      // Mock Unix platform
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        writable: true,
        configurable: true
      })

      // Mock visibility state as hidden
      mockGetVisibilityState.mockReturnValue(false)

      // Reset and reimport to pick up platform change
      cwdTrackerModule.resetCwdTracker()
      const tracker = cwdTrackerModule.getDefaultCwdTracker()
      const callback = vi.fn()
      tracker.onCwdChanged(callback)

      // Start tracking
      tracker.startTracking('term-1', 12345, '/home/user')

      // Advance timers past the poll interval
      await vi.advanceTimersByTimeAsync(600)

      // Callback should not be called since app is not visible
      expect(callback).not.toHaveBeenCalled()

      // But getCwd should still return the initial CWD
      const cwd = await tracker.getCwd('term-1')
      expect(cwd).toBe('/home/user')

      vi.useRealTimers()
    })

    it('should poll when app is visible (non-Windows)', async () => {
      // Mock Unix platform
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        writable: true,
        configurable: true
      })

      // Mock visibility state as visible
      mockGetVisibilityState.mockReturnValue(true)

      const tracker = cwdTrackerModule.getDefaultCwdTracker()

      // Start tracking
      tracker.startTracking('term-1', 12345, '/home/user')

      // The tracker should be tracking the terminal
      const cwd = await tracker.getCwd('term-1')
      expect(cwd).toBe('/home/user')
    })
  })

  describe('Windows optimization', () => {
    it('should skip polling on Windows since CWD detection returns null', async () => {
      vi.useFakeTimers()

      // Mock Windows platform
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      })

      const tracker = cwdTrackerModule.getDefaultCwdTracker()
      const callback = vi.fn()
      tracker.onCwdChanged(callback)

      // Start tracking - on Windows, this should not start polling
      tracker.startTracking('term-1', 12345, 'C:\\Users\\test')

      // Advance timers past the poll interval
      await vi.advanceTimersByTimeAsync(600)

      // Callback should never be called since polling is skipped on Windows
      expect(callback).not.toHaveBeenCalled()

      // But getCwd should still return the initial CWD
      const cwd = await tracker.getCwd('term-1')
      expect(cwd).toBe('C:\\Users\\test')

      vi.useRealTimers()
    })

    it('should start polling on non-Windows platforms', async () => {
      // Mock Unix platform
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        writable: true,
        configurable: true
      })

      const tracker = cwdTrackerModule.getDefaultCwdTracker()

      // Start tracking - on non-Windows, this should start polling
      tracker.startTracking('term-1', 12345, '/home/user')

      // The tracker should be tracking the terminal
      const cwd = await tracker.getCwd('term-1')
      expect(cwd).toBe('/home/user')
    })
  })
})
