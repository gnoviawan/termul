import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getDiff,
  generateCommitMessage,
  toastError,
  acpState,
  gitState,
  mobileRef,
  diffViewPropsRef
} = vi.hoisted(() => {
  const getDiff = vi.fn()
  const generateCommitMessage = vi.fn()
  const commit = vi.fn()
  const toastError = vi.fn()
  return {
    getDiff,
    generateCommitMessage,
    commit,
    toastError,
    acpState: {
      selectedAgentConfigId: 'cfg-1',
      agentConfigs: [{ id: 'cfg-1' }],
      generateCommitMessage
    },
    gitState: {
      statuses: {
        '/work': [
          { path: 'a.ts', staged: false, status: 'modified' },
          { path: 'b.ts', staged: true, status: 'added' }
        ]
      },
      diffs: {
        '/work:a.ts:true': 'diff for a.ts',
        '/work:a.ts:false': 'diff for a.ts'
      },
      selectedFile: null as string | null,
      setSelectedFile: vi.fn(),
      refreshStatus: vi.fn(),
      fetchDiff: vi.fn(),
      stageFiles: vi.fn(),
      unstageFiles: vi.fn(),
      discardFiles: vi.fn(),
      stageHunk: vi.fn(),
      unstageHunk: vi.fn(),
      commitContexts: {
        '/work': {
          stagedCount: 1,
          hasHead: true,
          lastSubject: '',
          lastBody: '',
          branch: 'dev',
          ahead: 0,
          behind: 0,
          hasUpstream: true
        }
      },
      fetchCommitContext: vi.fn(),
      commit,
      push: vi.fn(),
      stashes: {} as Record<string, Array<{ index: number; message: string }>>,
      branches: {},
      fetchStashes: vi.fn(),
      fetchBranches: vi.fn(),
      stashSave: vi.fn(),
      stashApply: vi.fn(),
      stashPop: vi.fn(),
      stashDrop: vi.fn(),
      branchSwitch: vi.fn(),
      branchCreate: vi.fn()
    },
    // Mutable so individual tests can flip the mobile branch on/off.
    mobileRef: { current: true as boolean },
    // Captures the props the mobile branch passes to GitDiffView.
    diffViewPropsRef: { current: null as Record<string, unknown> | null }
  }
})

vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/git-api', () => ({ gitApi: { getDiff } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/components/git/GitDiffView', () => ({
  GitDiffView: (props: Record<string, unknown>) => {
    diffViewPropsRef.current = props
    return <div data-testid="git-diff-view">diff view</div>
  }
}))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (state: Record<string, unknown>) => unknown) => selector(acpState)
}))
vi.mock('@/stores/git-status-store', () => ({
  diffKey: (cwd: string, path: string, staged: boolean) => `${cwd}:${path}:${staged}`,
  useGitStatusStore: (selector: (state: Record<string, unknown>) => unknown) => selector(gitState)
}))
vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

import { GitPanel } from './GitPanel'

function resetState() {
  vi.clearAllMocks()
  mobileRef.current = true
  gitState.selectedFile = null
  gitState.statuses['/work'] = [
    { path: 'a.ts', staged: false, status: 'modified' },
    { path: 'b.ts', staged: true, status: 'added' }
  ]
  gitState.commitContexts['/work'] = {
    stagedCount: 1,
    hasHead: true,
    lastSubject: '',
    lastBody: '',
    branch: 'dev',
    ahead: 0,
    behind: 0,
    hasUpstream: true
  }
  gitState.stashes['/work'] = []
  gitState.diffs = {
    '/work:a.ts:true': 'diff for a.ts',
    '/work:a.ts:false': 'diff for a.ts'
  }
  diffViewPropsRef.current = null
  getDiff.mockResolvedValue('diff for a.ts')
  generateCommitMessage.mockResolvedValue({ summary: 'S', description: '' })
}

describe('GitPanel mobile branch', () => {
  beforeEach(resetState)

  it('renders the file list full-width (no diff view) when no file is selected', () => {
    const { container } = render(<GitPanel cwd="/work" isVisible />)

    // File list is present: the branch dropdown + the filter input.
    expect(screen.getByPlaceholderText('Filter changes...')).toBeInTheDocument()
    // No back button (only shown when a file is selected).
    expect(screen.queryByLabelText('Back to file list')).not.toBeInTheDocument()
    // No diff view rendered (mobile hides the diff panel until a file is picked).
    expect(screen.queryByTestId('git-diff-view')).not.toBeInTheDocument()
    // Mobile file list is full-width, not the desktop `w-80` sidebar.
    expect(container.querySelector('.w-80')).toBeNull()
  })

  it('swaps to the diff view with a back button when a file is selected', () => {
    gitState.selectedFile = 'a.ts'
    render(<GitPanel cwd="/work" isVisible />)

    // Diff view + back button render; file list is hidden.
    expect(screen.getByTestId('git-diff-view')).toBeInTheDocument()
    expect(screen.getByLabelText('Back to file list')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
  })

  it('clears selectedFile when the back button is tapped', () => {
    gitState.selectedFile = 'a.ts'
    render(<GitPanel cwd="/work" isVisible />)

    fireEvent.click(screen.getByLabelText('Back to file list'))
    expect(gitState.setSelectedFile).toHaveBeenCalledWith(null)
  })
})

describe('GitPanel mobile branch (story 10 QA matrix)', () => {
  beforeEach(resetState)

  // Matrix row 1: stash actions visible + 44px floor + destructive drop token.
  it('stash apply/pop/drop are always visible, touch-sized, drop is destructive', () => {
    gitState.stashes['/work'] = [{ index: 0, message: 'wip on dev' }]
    const { container } = render(<GitPanel cwd="/work" isVisible />)

    const apply = screen.getByLabelText('Apply stash (keeps stash entry)')
    const pop = screen.getByLabelText('Pop stash (applies and drops)')
    const drop = screen.getByLabelText('Drop stash')

    // Repro the QA F4 dead control: no hover-gated opacity-0 anywhere in the
    // mobile render (the old stash actions were opacity-0 group-hover:*).
    expect(container.querySelector('[class*="opacity-0"]')).toBeNull()

    // `touch` size → h-11 (44px) with the w-11 icon width.
    for (const btn of [apply, pop, drop]) {
      expect(btn.className).toContain('h-11')
      expect(btn.className).toContain('w-11')
    }
    // Destructive token on drop (not raw red).
    expect(drop.className).toContain('hover:bg-destructive/10')
    expect(drop.className).toContain('hover:text-destructive')

    // Tapping dispatches the existing handlers.
    fireEvent.click(pop)
    expect(gitState.stashPop).toHaveBeenCalledWith('/work', 0)
  })

  // Matrix row 2: file-row actions meet the 44px hit floor via hit-slop.
  it('row actions use the touch hit-slop idiom (32px visual + inset overlay)', () => {
    render(<GitPanel cwd="/work" isVisible />)

    const stage = screen.getByLabelText('Stage changes')
    expect(stage.className).toContain('size-8')
    expect(stage.className).toContain('after:-inset-1.5')

    const discard = screen.getByLabelText('Discard changes')
    expect(discard.className).toContain('after:-inset-1.5')
    // Discard keeps its destructive token.
    expect(discard.className).toContain('hover:bg-destructive/10')
  })

  // Matrix row 3: mobile diff passes the per-hunk stage/unstage props.
  it('mobile GitDiffView receives diffSide + per-hunk stage/unstage handlers', () => {
    gitState.selectedFile = 'a.ts'
    render(<GitPanel cwd="/work" isVisible />)

    expect(diffViewPropsRef.current).not.toBeNull()
    expect(diffViewPropsRef.current?.diffSide).toBe('unstaged')
    expect(typeof diffViewPropsRef.current?.onStageHunk).toBe('function')
    expect(typeof diffViewPropsRef.current?.onUnstageHunk).toBe('function')
  })

  // Matrix row 4: filenames + dir names ≥12px on mobile rows.
  it('mobile filenames and directory labels render at the 12px text floor', () => {
    gitState.statuses['/work'] = [{ path: 'src/a.ts', staged: false, status: 'modified' }]
    render(<GitPanel cwd="/work" isVisible />)

    const name = screen.getByText('a.ts')
    expect(name.className).toContain('text-xs')
    expect(name.className).not.toContain('text-2xs')

    const dir = screen.getByText('src')
    expect(dir.className).toContain('text-xs')
    expect(dir.className).not.toContain('text-4xs')
  })

  // Matrix row 5 (stash labels): stash label + message ≥12px.
  it('stash labels and messages render at the 12px text floor', () => {
    gitState.stashes['/work'] = [{ index: 0, message: 'wip on dev' }]
    render(<GitPanel cwd="/work" isVisible />)

    const label = screen.getByText('stash@{0}')
    expect(label.className).toContain('text-xs')
    expect(label.className).not.toContain('text-3xs')

    const message = screen.getByText('wip on dev')
    expect(message.className).toContain('text-xs')
    expect(message.className).not.toContain('text-2xs')
  })

  // Matrix row 5 (amend label): ≥12px + contrast-compliant disabled state.
  it('amend label is 12px with a contrast-compliant disabled state', () => {
    const enabled = render(<GitPanel cwd="/work" isVisible />)
    const labelEnabled = enabled.getByText('Amend last commit').closest('label')
    expect(labelEnabled?.className).toContain('text-xs')
    expect(labelEnabled?.className).not.toContain('text-2xs')
    enabled.unmount()

    // No HEAD → disabled: /75 keeps ≥3:1 contrast on the dark background
    // (the old /40 was ~1.7:1 per QA F7).
    const ctx = gitState.commitContexts['/work'] as { hasHead: boolean }
    ctx.hasHead = false
    const disabled = render(<GitPanel cwd="/work" isVisible />)
    const labelDisabled = disabled.getByText('Amend last commit').closest('label')
    expect(labelDisabled?.className).toContain('text-muted-foreground/75')
    expect(labelDisabled?.className).not.toContain('/40')
  })

  // Matrix row 7: footer de-stacked — Commit primary, inline Generate
  // sparkle, de-weighted Amend, Publish in overflow when no upstream.
  it('footer with upstream: Commit primary + inline sparkle + direct push button', () => {
    render(<GitPanel cwd="/work" isVisible />)

    // Commit is the primary action (touch-sized).
    const commitBtn = screen.getByRole('button', { name: /Commit to dev/ })
    expect(commitBtn.className).toContain('h-11')

    // Generate message is the inline sparkle in the summary row, not a
    // stacked equal-weight button.
    expect(screen.getByLabelText('Generate commit message')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Generate message/ })).not.toBeInTheDocument()

    // Amend is a de-weighted checkbox label.
    expect(screen.getByText('Amend last commit')).toBeInTheDocument()

    // Upstream exists → push stays a direct (secondary) button.
    expect(screen.getByRole('button', { name: /Up to date/ })).toBeInTheDocument()
  })

  it('footer without upstream: Publish is reachable from the overflow trigger', () => {
    const ctx = gitState.commitContexts['/work'] as { hasUpstream: boolean }
    ctx.hasUpstream = false
    render(<GitPanel cwd="/work" isVisible />)

    // Overflow trigger is present (More actions)…
    const overflow = screen.getByRole('button', { name: 'More actions' })
    expect(overflow).toBeInTheDocument()
    // …and Publish branch is not promoted to the footer row while the
    // dropdown is closed (two visible buttons max: Commit + overflow).
    expect(screen.queryByText('Publish branch')).not.toBeInTheDocument()
    // Commit remains the single primary.
    expect(screen.getByRole('button', { name: /Commit to dev/ })).toBeInTheDocument()
  })
})

describe('GitPanel desktop branch (regression — byte-identical layout)', () => {
  beforeEach(() => {
    resetState()
    mobileRef.current = false
    gitState.selectedFile = 'a.ts'
  })

  it('renders the two-column layout (file list sidebar + diff) when a file is selected', () => {
    const { container } = render(<GitPanel cwd="/work" isVisible />)

    // Desktop keeps the `w-80` file-list sidebar AND the diff view side-by-side.
    expect(container.querySelector('.w-80')).not.toBeNull()
    expect(screen.getByTestId('git-diff-view')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Filter changes...')).toBeInTheDocument()
    // Desktop never renders the mobile back button.
    expect(screen.queryByLabelText('Back to file list')).not.toBeInTheDocument()
  })

  // Matrix row 8: desktop unchanged — dense sizing + hover idioms preserved.
  it('desktop keeps dense row actions, sub-12px text, and hover-gated stash actions', () => {
    gitState.selectedFile = null
    gitState.statuses['/work'] = [{ path: 'src/a.ts', staged: false, status: 'modified' }]
    gitState.stashes['/work'] = [{ index: 0, message: 'wip on dev' }]
    render(<GitPanel cwd="/work" isVisible />)

    // Desktop row actions stay 24×24 with no hit-slop.
    const stage = screen.getByLabelText('Stage changes')
    expect(stage.className).toContain('h-6 w-6')
    expect(stage.className).not.toContain('size-8')
    expect(stage.className).not.toContain('after:-inset-1.5')

    // Desktop filename keeps the dense text-2xs / dir text-4xs scale.
    expect(screen.getByText('a.ts').className).toContain('text-2xs')
    expect(screen.getByText('src').className).toContain('text-4xs')

    // Desktop stash actions keep the hover-only opacity-0 group idiom and the
    // destructive token swap (token-equivalent, no layout change).
    const drop = screen.getByTitle('Drop stash')
    expect(drop.parentElement?.className).toContain('opacity-0')
    expect(drop.className).toContain('hover:bg-destructive/10')

    // Desktop amend label keeps text-2xs; Generate stays a stacked button.
    expect(screen.getByText('Amend last commit').closest('label')?.className).toContain('text-2xs')
    expect(screen.getByRole('button', { name: /Generate message/ })).toBeInTheDocument()
    expect(screen.queryByLabelText('Generate commit message')).not.toBeInTheDocument()
  })
})
