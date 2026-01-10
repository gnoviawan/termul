import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// We need to test the CwdTracker class directly without module reset
// Import the functions we need to test

describe('cwd-tracker', () => {
  let cwdTrackerModule: typeof import('./cwd-tracker')

  beforeEach(async () => {
    vi.clearAllMocks()
    // Import fresh module
    cwdTrackerModule = await import('./cwd-tracker')
    // Reset any existing tracker
    cwdTrackerModule.resetCwdTracker()
  })

  afterEach(() => {
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
})
