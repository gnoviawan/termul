import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '@/types/project'
import { LauncherContextStrip } from './context-strip'
import type { LaunchWorkspace } from './use-launch-workspace'

// Radix Select portals do not render under jsdom.
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null
}))

const worktree: Worktree = {
  id: 'a',
  name: 'a',
  branch: 'feat/a',
  path: '/p/.termul/worktrees/a',
  createdAt: '2026-01-01T00:00:00.000Z'
}

function workspace(over: Partial<LaunchWorkspace> = {}): LaunchWorkspace {
  return {
    isolationMode: 'current',
    setIsolationMode: vi.fn(),
    existingWorktreeId: null,
    setExistingWorktreeId: vi.fn(),
    pickIsProjectFolder: true,
    resetWorkspace: vi.fn(),
    ...over
  }
}

function strip(over: Partial<LaunchWorkspace> = {}): React.JSX.Element {
  return (
    <LauncherContextStrip
      workspace={workspace(over)}
      worktrees={[worktree]}
      baseBranch={null}
      setBaseBranch={vi.fn()}
      baseBranchInfo={null}
      baseOptions={[]}
      interactive
      gitBranch="main"
      isGitRepo
    />
  )
}

describe('LauncherContextStrip', () => {
  afterEach(cleanup)

  it('shows the read-only branch beside the Current checkout chip', () => {
    render(strip())
    expect(screen.getByText('main')).toBeInTheDocument()
    cleanup()
    render(
      <LauncherContextStrip
        workspace={workspace()}
        worktrees={[]}
        baseBranch={null}
        setBaseBranch={vi.fn()}
        baseBranchInfo={null}
        baseOptions={[]}
        interactive
        gitBranch={null}
        isGitRepo
      />
    )
    expect(screen.getByText('Detached HEAD')).toBeInTheDocument()
  })
})
