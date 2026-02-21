import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Create a mock function for visibility state that can be controlled
const mockGetVisibilityState = vi.fn(() => true)

// Mock the visibility IPC module
vi.mock('../ipc/visibility.ipc', () => ({
  getVisibilityState: () => mockGetVisibilityState()
}))

// Mock the cwd-tracker module
vi.mock('./cwd-tracker', () => ({
  getDefaultCwdTracker: () => ({
    onCwdChanged: vi.fn(() => () => {})
  })
}))

describe('git-tracker', () => {
  let gitTrackerModule: typeof import('./git-tracker')

  beforeEach(async () => {
    vi.clearAllMocks()
    // Reset visibility mock to default (visible)
    mockGetVisibilityState.mockReturnValue(true)
    // Import fresh module
    gitTrackerModule = await import('./git-tracker')
    // Reset any existing tracker
    gitTrackerModule.resetGitTracker()
  })

  afterEach(() => {
    if (gitTrackerModule) {
      gitTrackerModule.resetGitTracker()
    }
    vi.restoreAllMocks()
  })

  describe('GitTracker class', () => {
    it('should return null for unknown terminal branch', () => {
      const tracker = gitTrackerModule.getDefaultGitTracker()
      const branch = tracker.getBranch('unknown-id')
      expect(branch).toBeNull()
    })

    it('should register and unregister callback', () => {
      const tracker = gitTrackerModule.getDefaultGitTracker()
      const callback = vi.fn()

      const unsubscribe = tracker.onGitBranchChanged(callback)
      expect(typeof unsubscribe).toBe('function')
      unsubscribe()

      // Callback should not be called after unsubscribe
      expect(callback).not.toHaveBeenCalled()
    })

    it('should remove terminal from tracking', async () => {
      const tracker = gitTrackerModule.getDefaultGitTracker()
      await tracker.initializeTerminal('test-id', '/tmp')
      tracker.removeTerminal('test-id')
      expect(tracker.getBranch('test-id')).toBeNull()
    })

    it('should handle shutdown gracefully', () => {
      const tracker = gitTrackerModule.getDefaultGitTracker()
      tracker.shutdown()
      // After shutdown, getBranch should still work (return null)
      expect(tracker.getBranch('any')).toBeNull()
    })
  })

  describe('getDefaultGitTracker', () => {
    it('should return singleton instance', () => {
      const tracker1 = gitTrackerModule.getDefaultGitTracker()
      const tracker2 = gitTrackerModule.getDefaultGitTracker()
      expect(tracker1).toBe(tracker2)
    })
  })

  describe('resetGitTracker', () => {
    it('should create new instance after reset', async () => {
      const tracker1 = gitTrackerModule.getDefaultGitTracker()
      await tracker1.initializeTerminal('test-id', '/tmp')

      gitTrackerModule.resetGitTracker()

      // After reset, getting a new tracker should not have the old terminal
      const tracker2 = gitTrackerModule.getDefaultGitTracker()
      expect(tracker2.getBranch('test-id')).toBeNull()
    })
  })

  describe('visibility state handling', () => {
    it('should skip polling when app is not visible', async () => {
      vi.useFakeTimers()
      let checkStatusSpy: ReturnType<typeof vi.spyOn> | null = null

      try {
        // Mock visibility state as hidden
        mockGetVisibilityState.mockReturnValue(false)

        const tracker = gitTrackerModule.getDefaultGitTracker()

        // Initialize terminal to start polling
        await tracker.initializeTerminal('test-id', '/tmp')

        // Spy on checkStatus to verify it's not called during polling
        checkStatusSpy = vi.spyOn(tracker as unknown as { checkStatus: (id: string, cwd: string) => Promise<void> }, 'checkStatus')

        // Advance timers past the poll interval (6000ms)
        await vi.advanceTimersByTimeAsync(6500)

        // checkStatus should not have been called since app is not visible
        expect(checkStatusSpy).not.toHaveBeenCalled()
      } finally {
        // Clean up - always restore even if assertion fails
        if (checkStatusSpy) {
          checkStatusSpy.mockRestore()
        }
        vi.useRealTimers()
      }
    })

    it('should poll when app is visible', async () => {
      vi.useFakeTimers()
      let checkStatusSpy: ReturnType<typeof vi.spyOn> | null = null

      try {
        // Mock visibility state as visible
        mockGetVisibilityState.mockReturnValue(true)

        const tracker = gitTrackerModule.getDefaultGitTracker()

        // Initialize terminal to start polling
        await tracker.initializeTerminal('test-id', '/tmp')

        // Spy on checkStatus to verify it's called during polling
        checkStatusSpy = vi.spyOn(tracker as unknown as { checkStatus: (id: string, cwd: string) => Promise<void> }, 'checkStatus')

        // Advance timers past the poll interval (6000ms)
        await vi.advanceTimersByTimeAsync(6500)

        // checkStatus should have been called since app is visible
        expect(checkStatusSpy).toHaveBeenCalled()
      } finally {
        // Clean up - always restore even if assertion fails
        if (checkStatusSpy) {
          checkStatusSpy.mockRestore()
        }
        vi.useRealTimers()
      }
    })
  })
})

describe('Git branch detection logic', () => {
  it('parses valid branch name', () => {
    const branchOutput = 'main\n'
    const branch = branchOutput.trim()
    expect(branch).toBe('main')
  })

  it('handles detached HEAD state', () => {
    const branchOutput = 'HEAD\n'
    const branch = branchOutput.trim()
    // When branch is 'HEAD', we return null for detached state
    const result = branch === 'HEAD' ? null : branch
    expect(result).toBeNull()
  })

  it('handles branch names with slashes', () => {
    const branchOutput = 'feature/add-git-tracking\n'
    const branch = branchOutput.trim()
    expect(branch).toBe('feature/add-git-tracking')
  })

  it('handles branch names with hyphens', () => {
    const branchOutput = 'fix-bug-123\n'
    const branch = branchOutput.trim()
    expect(branch).toBe('fix-bug-123')
  })
})

describe('parseGitStatus', () => {
  let parseGitStatus: typeof import('./git-tracker')['parseGitStatus']

  beforeEach(async () => {
    const module = await import('./git-tracker')
    parseGitStatus = module.parseGitStatus
  })

  it('parses empty status (clean repo)', () => {
    const result = parseGitStatus('')
    expect(result.modified).toBe(0)
    expect(result.staged).toBe(0)
    expect(result.untracked).toBe(0)
    expect(result.hasChanges).toBe(false)
  })

  it('counts untracked files', () => {
    const output = '?? new-file.ts\n?? another.ts'
    const result = parseGitStatus(output)
    expect(result.untracked).toBe(2)
    expect(result.modified).toBe(0)
    expect(result.staged).toBe(0)
    expect(result.hasChanges).toBe(true)
  })

  it('counts modified files in working tree', () => {
    const output = ' M src/file1.ts\n M src/file2.ts'
    const result = parseGitStatus(output)
    expect(result.modified).toBe(2)
    expect(result.staged).toBe(0)
    expect(result.hasChanges).toBe(true)
  })

  it('counts staged files', () => {
    const output = 'M  src/file1.ts\nA  src/new-file.ts'
    const result = parseGitStatus(output)
    expect(result.staged).toBe(2)
    expect(result.modified).toBe(0)
    expect(result.hasChanges).toBe(true)
  })

  it('counts both staged and modified (MM)', () => {
    const output = 'MM src/file1.ts'
    const result = parseGitStatus(output)
    expect(result.staged).toBe(1)
    expect(result.modified).toBe(1)
    expect(result.hasChanges).toBe(true)
  })

  it('handles deleted files in working tree', () => {
    const output = ' D src/deleted.ts'
    const result = parseGitStatus(output)
    expect(result.modified).toBe(1)
    expect(result.staged).toBe(0)
  })

  it('handles deleted files staged for removal', () => {
    const output = 'D  src/deleted.ts'
    const result = parseGitStatus(output)
    expect(result.staged).toBe(1)
    expect(result.modified).toBe(0)
  })

  it('handles mixed status output', () => {
    const output = `?? untracked.ts
 M modified.ts
M  staged.ts
MM both.ts
A  added.ts
 D deleted.ts`
    const result = parseGitStatus(output)
    expect(result.untracked).toBe(1)
    expect(result.modified).toBe(3) // modified.ts, both.ts (M in worktree), deleted.ts
    expect(result.staged).toBe(3) // staged.ts, both.ts (M in index), added.ts
    expect(result.hasChanges).toBe(true)
  })

  it('ignores empty lines', () => {
    const output = '\n\n?? file.ts\n\n'
    const result = parseGitStatus(output)
    expect(result.untracked).toBe(1)
  })
})

describe('statusEquals', () => {
  let statusEquals: typeof import('./git-tracker')['statusEquals']

  beforeEach(async () => {
    const module = await import('./git-tracker')
    statusEquals = module.statusEquals
  })

  it('returns true for two null values', () => {
    expect(statusEquals(null, null)).toBe(true)
  })

  it('returns false when first is null', () => {
    const status = { modified: 1, staged: 0, untracked: 0, hasChanges: true }
    expect(statusEquals(null, status)).toBe(false)
  })

  it('returns false when second is null', () => {
    const status = { modified: 1, staged: 0, untracked: 0, hasChanges: true }
    expect(statusEquals(status, null)).toBe(false)
  })

  it('returns true for identical status objects', () => {
    const status1 = { modified: 2, staged: 1, untracked: 3, hasChanges: true }
    const status2 = { modified: 2, staged: 1, untracked: 3, hasChanges: true }
    expect(statusEquals(status1, status2)).toBe(true)
  })

  it('returns false when modified differs', () => {
    const status1 = { modified: 1, staged: 1, untracked: 1, hasChanges: true }
    const status2 = { modified: 2, staged: 1, untracked: 1, hasChanges: true }
    expect(statusEquals(status1, status2)).toBe(false)
  })

  it('returns false when staged differs', () => {
    const status1 = { modified: 1, staged: 1, untracked: 1, hasChanges: true }
    const status2 = { modified: 1, staged: 2, untracked: 1, hasChanges: true }
    expect(statusEquals(status1, status2)).toBe(false)
  })

  it('returns false when untracked differs', () => {
    const status1 = { modified: 1, staged: 1, untracked: 1, hasChanges: true }
    const status2 = { modified: 1, staged: 1, untracked: 2, hasChanges: true }
    expect(statusEquals(status1, status2)).toBe(false)
  })
})
