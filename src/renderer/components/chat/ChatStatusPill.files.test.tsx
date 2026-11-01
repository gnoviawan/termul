import type { GitDiffStat, GitStatusDetail } from '@shared/types/ipc.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import { normalizePath } from '@/lib/working-copy'
import { resetGitStatusStoreControlForTests, useGitStatusStore } from '@/stores/git-status-store'

const { openFileRef, addEditorTabRef, logFrontendErrorRef, toastErrorRef, mobileRef, gitApiMock } =
  vi.hoisted(() => ({
    openFileRef: { current: vi.fn(async () => {}) },
    addEditorTabRef: { current: vi.fn() },
    logFrontendErrorRef: { current: vi.fn(async () => {}) },
    toastErrorRef: { current: vi.fn() },
    mobileRef: { current: false },
    gitApiMock: {
      getStatus: vi.fn(),
      getDiffStat: vi.fn(),
      getCommitContext: vi.fn(),
      getLog: vi.fn(),
      discard: vi.fn()
    }
  }))

vi.mock('@/lib/git-api', () => ({ gitApi: gitApiMock }))

vi.mock('@tauri-apps/plugin-os', () => ({ platform: vi.fn(() => 'linux') }))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return { ...actual, useReducedMotion: () => true }
})

const NOT_A_REPO = 'fatal: not a git repository'

/** The cwd is not a git repository: the panel falls back to agent tool calls. */
function seedNotARepo(cwd: string) {
  gitApiMock.getStatus.mockRejectedValue(new Error(NOT_A_REPO))
  gitApiMock.getDiffStat.mockRejectedValue(new Error(NOT_A_REPO))
  if (!cwd) return
  useGitStatusStore.setState((state) => ({
    errors: { ...state.errors, [normalizePath(cwd)]: { status: NOT_A_REPO } }
  }))
}

beforeEach(() => {
  resetGitStatusStoreControlForTests()
  useGitStatusStore.setState({ paths: {}, statuses: {}, diffStats: {}, errors: {} })
  gitApiMock.getStatus.mockReset()
  gitApiMock.getDiffStat.mockReset()
  gitApiMock.getCommitContext.mockReset()
  gitApiMock.getLog.mockReset()
  gitApiMock.discard.mockReset()
  gitApiMock.getCommitContext.mockResolvedValue({ hasHead: false })
  gitApiMock.getLog.mockResolvedValue([])
  gitApiMock.discard.mockResolvedValue(undefined)
  seedNotARepo('/work')
})

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current
}))

vi.mock('@/stores/editor-store', () => {
  const fn = () => {}
  fn.getState = () => ({ openFile: openFileRef.current })
  return { useEditorStore: fn }
})

vi.mock('@/stores/workspace-store', () => {
  const fn = () => {}
  fn.getState = () => ({ addEditorTab: addEditorTabRef.current })
  return { useWorkspaceStore: fn }
})

vi.mock('@/lib/log-api', () => ({
  logFrontendError: (...args: unknown[]) => logFrontendErrorRef.current(...args)
}))

vi.mock('@/lib/utils', () => ({
  cn: (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(' ')
}))

vi.mock('@/components/file-explorer/MaterialFileIcon', () => ({
  MaterialFileIcon: ({ name }: { name: string }) => (
    <span data-testid="file-icon" data-name={name} />
  )
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: (...args: unknown[]) => toastErrorRef.current(...args)
  })
}))

import { ChatStatusPill } from './ChatStatusPill'

/** The pill with no subagents: only the changed files show. */
function Pill(props: {
  cwd: string
  toolCalls: ToolCall[]
  turnActive?: boolean
  onOpenGitChanges?: (opener: HTMLElement) => void
}) {
  return (
    <ChatStatusPill
      sessionId="s1"
      messages={[]}
      filePathContext={undefined}
      {...props}
      turnActive={props.turnActive ?? false}
    />
  )
}

const pill = () => screen.getByRole('button', { name: /^Session status:/ })
const noPill = () => expect(screen.queryByRole('button', { name: /^Session status:/ })).toBeNull()

function makeToolCall(overrides: Partial<ToolCall> & { kind?: string; path?: string }): ToolCall {
  const kind = overrides.kind ?? 'edit'
  const path = overrides.path ?? 'src/foo.ts'
  return {
    toolCallId: overrides.toolCallId ?? 'tc-1',
    kind,
    status: 'completed',
    content: [{ type: 'diff', path, oldText: 'old', newText: 'new' }],
    rawInput: { filePath: path },
    ...overrides
  } as ToolCall
}

function renderPanel(toolCalls: ToolCall[] = [], cwd: string = '/work') {
  seedNotARepo(cwd)
  return render(<Pill cwd={cwd} toolCalls={toolCalls} />)
}

const THREE_EDITS = [
  makeToolCall({ toolCallId: 'e1', path: 'src/a.ts' }),
  makeToolCall({ toolCallId: 'e2', path: 'src/b.ts' }),
  makeToolCall({ toolCallId: 'e3', path: 'src/c.ts' })
]

describe('ChatStatusPill changed files', () => {
  beforeEach(() => {
    mobileRef.current = false
    openFileRef.current = vi.fn(async () => {})
    addEditorTabRef.current = vi.fn()
    logFrontendErrorRef.current = vi.fn(async () => {})
    toastErrorRef.current = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders nothing when there are no file-changing tool calls', () => {
    renderPanel([])
    noPill()
  })

  it('renders nothing for non-edit tool calls (read, search, execute)', () => {
    renderPanel([
      makeToolCall({ toolCallId: 'r1', kind: 'read', path: 'src/a.ts' }),
      makeToolCall({ toolCallId: 's1', kind: 'search', path: 'src/b.ts' })
    ])
    noPill()
  })

  it('renders the header with count badge when edit tool calls exist', () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
      makeToolCall({ toolCallId: 'e2', path: 'src/bar.ts' })
    ])
    expect(pill()).toBeInTheDocument()
    expect(pill()).toHaveAccessibleName('Session status: 2 changed files')
  })

  it('shows total +/- counts on the header bar', () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
      makeToolCall({ toolCallId: 'e2', path: 'src/bar.ts' })
    ])
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('−2')).toBeInTheDocument()
  })

  it('expands and shows file rows on header click', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
      makeToolCall({ toolCallId: 'e2', path: 'src/bar.ts' })
    ])
    fireEvent.click(pill())
    expect(await screen.findByText('foo.ts')).toBeInTheDocument()
    expect(screen.getByText('bar.ts')).toBeInTheDocument()
  })

  it('passes each row file name to the file-type icon', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
      makeToolCall({ toolCallId: 'e2', path: 'src-tauri/src/mod.RS' }),
      makeToolCall({ toolCallId: 'e3', path: 'docs/spec.test.md' }),
      makeToolCall({ toolCallId: 'e4', path: 'Makefile' }),
      makeToolCall({ toolCallId: 'e5', path: '.gitignore' }),
      makeToolCall({ toolCallId: 'e6', path: 'C:\\repo\\App.TSX' })
    ])
    fireEvent.click(pill())
    await screen.findByText('foo.ts')
    const icons = screen.getAllByTestId('file-icon').map((el) => el.dataset.name)
    expect(icons).toEqual(['foo.ts', 'mod.RS', 'spec.test.md', 'Makefile', '.gitignore', 'App.TSX'])
  })

  it('opens the file in the editor when a row is clicked', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.click(row)
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
      expect(addEditorTabRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
    })
  })

  it('uses a native button for each file row', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    expect(row.tagName).toBe('BUTTON')
    expect(row).toHaveAttribute('type', 'button')
  })

  it('normalizes backslash cwd separators when opening files', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })], 'E:\\repo')
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.click(row)
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('E:/repo/src/foo.ts')
    })
  })

  it('merges drive-letter case variants into one row', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'c:/repo/src/foo.ts' }),
      makeToolCall({ toolCallId: 'e2', path: 'C:/repo/src/foo.ts' })
    ])
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
  })

  it('merges a lowercase-drive path with a cwd-relative one', async () => {
    renderPanel(
      [
        makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
        makeToolCall({ toolCallId: 'e2', path: 'e:/repo/src/foo.ts' })
      ],
      'E:\\repo'
    )
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.click(row)
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('E:/repo/src/foo.ts')
    })
  })

  it('keeps the UNC prefix when resolving a relative path against a UNC cwd', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })], '\\\\server\\share\\repo')
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    expect(row).toHaveAttribute('title', '//server/share/repo/src/foo.ts')
    fireEvent.click(row)
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('//server/share/repo/src/foo.ts')
    })
  })

  it('toasts and logs when openFile fails', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    openFileRef.current = vi.fn(async () => {
      throw new Error('read error')
    })
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.click(row)
    await waitFor(() => {
      expect(toastErrorRef.current).toHaveBeenCalledWith('Could not open file')
      expect(logFrontendErrorRef.current).toHaveBeenCalled()
    })
    expect(addEditorTabRef.current).not.toHaveBeenCalled()
  })

  it('shows the basename with a dimmed cwd-relative directory subtitle', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/deep/foo.ts' })])
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    // The full resolved path lives on the row's tooltip.
    expect(row).toHaveAttribute('title', '/work/src/deep/foo.ts')
    expect(row).toHaveTextContent('foo.ts')
    // Directory part is cwd-relative and dimmed (FileItem-style opacity-50).
    const dir = screen.getByText('src/deep')
    expect(dir.className).toContain('opacity-50')
  })

  it('omits the directory subtitle for basename-only paths', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'foo.ts' })])
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    expect(row).toHaveAttribute('title', '/work/foo.ts')
    expect(screen.getByText('foo.ts')).toBeInTheDocument()
    // No directory part → no dimmed subtitle span.
    expect(row.querySelector('.text-4xs')).toBeNull()
  })

  it('shows per-file +/- counts when expanded', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    fireEvent.click(pill())
    await screen.findByText('foo.ts')
    expect(screen.getAllByText('+1').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('−1').length).toBeGreaterThanOrEqual(2)
  })

  it('deduplicates a file edited by 3 tool calls into one row with summed counts', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
      makeToolCall({ toolCallId: 'e2', path: 'src/foo.ts' }),
      makeToolCall({ toolCallId: 'e3', path: 'src/foo.ts' })
    ])
    // Badge counts unique files; header totals still sum every call.
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
    fireEvent.click(pill())
    // Exactly one row (findByText throws on multiple matches) showing +3 −3.
    await screen.findByText('foo.ts')
    // One occurrence each in the row, the popover header and the pill totals.
    expect(screen.getAllByText('+3')).toHaveLength(3)
    expect(screen.getAllByText('−3')).toHaveLength(3)
  })

  it('merges a relative and an absolute path to the same file under cwd', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
      makeToolCall({ toolCallId: 'e2', path: '/work/src/foo.ts' })
    ])
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.click(row)
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
      expect(addEditorTabRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
    })
  })

  it('keeps relative-path rows keyed on their normalized form when cwd is empty', async () => {
    renderPanel(
      [
        makeToolCall({ toolCallId: 'e1', path: 'src\\foo.ts' }),
        makeToolCall({ toolCallId: 'e2', path: 'src/foo.ts' })
      ],
      ''
    )
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    expect(row).toHaveAttribute('title', 'src/foo.ts')
    fireEvent.click(row)
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('src/foo.ts')
    })
  })

  it('merges a move call and a later edit of the same path into one row', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'm1', kind: 'move', path: 'b.ts' }),
      makeToolCall({ toolCallId: 'e1', kind: 'edit', path: 'b.ts' })
    ])
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
    fireEvent.click(pill())
    expect(await screen.findByText('b.ts')).toBeInTheDocument()
  })

  it('collapses a delete followed by a recreate edit into one row', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'a.ts', content: [] }),
      makeToolCall({ toolCallId: 'e1', kind: 'edit', path: 'a.ts' })
    ])
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
    fireEvent.click(pill())
    expect(await screen.findByText('a.ts')).toBeInTheDocument()
  })

  it('merges zero-stat calls and keeps the summed diff counts', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'a.ts', content: [] }),
      makeToolCall({
        toolCallId: 'e1',
        path: 'a.ts',
        content: [{ type: 'diff', path: 'a.ts', oldText: 'l1\nl2', newText: 'n1\nn2\nn3\nn4\nn5' }]
      })
    ])
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: /a\.ts/i })
    expect(row).toHaveTextContent('+5')
    expect(row).toHaveTextContent('−2')
  })

  it('keeps first-appearance order when a file is touched again later', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'b.ts' }),
      makeToolCall({ toolCallId: 'e2', path: 'a.ts' }),
      makeToolCall({ toolCallId: 'e3', path: 'b.ts' })
    ])
    fireEvent.click(pill())
    await screen.findByText('b.ts')
    const titles = Array.from(document.querySelectorAll('button[title]')).map((el) =>
      el.getAttribute('title')
    )
    expect(titles).toEqual(['/work/b.ts', '/work/a.ts'])
  })

  it('dedupes dot segments, duplicate slashes, and trailing separators', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
      makeToolCall({ toolCallId: 'e2', path: './src/foo.ts' }),
      makeToolCall({ toolCallId: 'e3', path: 'src//deep/../foo.ts' }),
      makeToolCall({ toolCallId: 'e4', path: 'src/foo.ts/' })
    ])
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
    fireEvent.click(pill())
    // The row's aria-label carries the canonical resolved path.
    expect(
      await screen.findByRole('button', { name: '/work/src/foo.ts, Modified' })
    ).toBeInTheDocument()
  })

  it('skips a whitespace-only tool-call path', () => {
    renderPanel([
      makeToolCall({
        toolCallId: 'e1',
        rawInput: {},
        content: [],
        locations: [{ path: '   ' }]
      })
    ])
    noPill()
  })

  it('shows the absolute directory subtitle for a file outside cwd', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: '/etc/hosts' })])
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: '/etc/hosts, Modified' })
    expect(row).toHaveAttribute('title', '/etc/hosts')
    expect(screen.getByText('hosts')).toBeInTheDocument()
    const dir = screen.getByText('/etc')
    expect(dir.className).toContain('opacity-50')
  })

  it('includes delete and move tool kinds', () => {
    renderPanel([
      makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'old.ts' }),
      makeToolCall({ toolCallId: 'm1', kind: 'move', path: 'moved.ts' })
    ])
    expect(pill()).toHaveAccessibleName('Session status: 2 changed files')
  })

  it('persists across agent replies (does not clear on turn end)', () => {
    // The panel has no activeTurn prop — it shows whenever toolCalls exist.
    // This test confirms the design: no activeTurn gating.
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    expect(pill()).toBeInTheDocument()
  })

  it('resolves file path from ACP locations field when rawInput has no path key', () => {
    renderPanel([
      makeToolCall({
        toolCallId: 'e1',
        path: undefined as unknown as string,
        rawInput: { command: 'sed -i ...' },
        locations: [{ path: 'src/from-locations.ts' }]
      })
    ])
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
  })

  it('prefers locations path over rawInput path', () => {
    renderPanel([
      makeToolCall({
        toolCallId: 'e1',
        rawInput: { filePath: 'src/from-input.ts' },
        locations: [{ path: 'src/from-locations.ts' }]
      })
    ])
    fireEvent.click(pill())
    expect(screen.getByText('from-locations.ts')).toBeInTheDocument()
  })

  it('renders rows with counts from restored summary-only tool calls', async () => {
    // Payload `toolCalls` after a reload: locations + host diffStat, no
    // content/rawInput/title (never persisted). Two edits of a.ts fold into
    // one row summing +3−1 and +2−0.
    const summary = (toolCallId: string, path: string, added: number, removed: number) =>
      ({
        toolCallId,
        kind: 'edit',
        status: 'completed',
        locations: [{ path }],
        diffStat: { added, removed },
        seq: 1,
        timestamp: 1,
        restoredSummary: true
      }) as ToolCall
    renderPanel([summary('r1', 'src/a.ts', 3, 1), summary('r2', 'src/a.ts', 2, 0)])
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
    fireEvent.click(pill())
    await screen.findByText('a.ts')
    // One occurrence each in the row, the popover header and the pill totals.
    expect(screen.getAllByText('+5')).toHaveLength(3)
    expect(screen.getAllByText('\u22121')).toHaveLength(3)
  })

  it('shows panel when locations is present even without diff content', () => {
    renderPanel([
      makeToolCall({
        toolCallId: 'e1',
        path: undefined as unknown as string,
        content: [],
        rawInput: {},
        locations: [{ path: 'src/edited-via-locations.ts' }]
      })
    ])
    expect(pill()).toBeInTheDocument()
  })
})

describe('ChatStatusPill changed-file kind', () => {
  beforeEach(() => {
    mobileRef.current = false
    openFileRef.current = vi.fn(async () => {})
    addEditorTabRef.current = vi.fn()
  })

  function openPill() {
    fireEvent.click(pill())
  }

  it('shows the GitPanel status letter for an edited, a deleted and a moved file', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', kind: 'edit', path: 'src/edited.ts' }),
      makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'src/gone.ts', content: [] }),
      makeToolCall({ toolCallId: 'm1', kind: 'move', path: 'src/moved.ts', content: [] })
    ])
    openPill()
    const edited = await screen.findByRole('button', { name: '/work/src/edited.ts, Modified' })
    const deleted = screen.getByRole('group', { name: 'Deleted: /work/src/gone.ts' })
    const moved = screen.getByRole('button', { name: '/work/src/moved.ts, Renamed' })

    const letter = (row: HTMLElement, name: string) => within(row).getByRole('img', { name })
    expect(letter(edited, 'Modified').textContent).toBe('M')
    expect(letter(edited, 'Modified').className).toContain('text-diff-modified')
    expect(letter(deleted, 'Deleted').textContent).toBe('D')
    expect(letter(deleted, 'Deleted').className).toContain('text-destructive')
    expect(letter(moved, 'Renamed').textContent).toBe('R')
    expect(letter(moved, 'Renamed').className).toContain('text-diff-modified')
  })

  it('renders a deleted file as a struck-through row that does not open', async () => {
    renderPanel([makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'src/gone.ts' })])
    openPill()
    const row = await screen.findByRole('group', { name: 'Deleted: /work/src/gone.ts' })
    expect(row.tagName).toBe('DIV')
    expect(row).toHaveAttribute('title', 'Deleted: /work/src/gone.ts')
    expect(screen.queryByRole('button', { name: /gone\.ts/ })).not.toBeInTheDocument()
    expect(screen.getByText('gone.ts').parentElement?.className).toContain('line-through')
    expect(row.className).toContain('cursor-default')
    expect(row.className).not.toMatch(/hover:|active:|cursor-pointer/)

    fireEvent.click(row)
    fireEvent.click(screen.getByText('gone.ts'))
    await Promise.resolve()
    expect(openFileRef.current).not.toHaveBeenCalled()
    expect(addEditorTabRef.current).not.toHaveBeenCalled()
  })

  it('marks a file deleted when its last call deletes it after edits', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', kind: 'edit', path: 'src/a.ts' }),
      makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'src/a.ts', content: [] })
    ])
    openPill()
    const row = await screen.findByRole('group', { name: 'Deleted: /work/src/a.ts' })
    expect(within(row).getByText('+1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /a\.ts/ })).not.toBeInTheDocument()
  })

  it('opens a file that was deleted and then recreated, marked modified', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'src/a.ts', content: [] }),
      makeToolCall({ toolCallId: 'e1', kind: 'edit', path: 'src/a.ts' })
    ])
    openPill()
    const row = await screen.findByRole('button', { name: '/work/src/a.ts, Modified' })
    expect(within(row).getByRole('img', { name: 'Modified' }).textContent).toBe('M')
    fireEvent.click(row)
    await waitFor(() => expect(openFileRef.current).toHaveBeenCalledWith('/work/src/a.ts'))
  })

  it.each([
    ['failed', 'failed'],
    ['pending approval', 'pending'],
    ['in progress', 'in_progress']
  ])('keeps a file openable when its only delete call is %s', async (_label, status) => {
    renderPanel([
      makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'src/kept.ts', content: [], status })
    ])
    openPill()
    const row = await screen.findByRole('button', { name: '/work/src/kept.ts' })
    expect(within(row).queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /kept\.ts/ })).not.toBeInTheDocument()
    fireEvent.click(row)
    await waitFor(() => expect(openFileRef.current).toHaveBeenCalledWith('/work/src/kept.ts'))
  })

  it.each([
    ['failed', 'failed'],
    ['pending approval', 'pending']
  ])('keeps an edited file modified and openable after a %s delete', async (_label, status) => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', kind: 'edit', path: 'src/kept.ts' }),
      makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'src/kept.ts', content: [], status })
    ])
    openPill()
    const row = await screen.findByRole('button', { name: '/work/src/kept.ts, Modified' })
    expect(within(row).getByRole('img', { name: 'Modified' }).textContent).toBe('M')
    fireEvent.click(row)
    await waitFor(() => expect(openFileRef.current).toHaveBeenCalledWith('/work/src/kept.ts'))
  })

  it('ignores a failed edit when picking the kind after a delete', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'src/gone.ts', content: [] }),
      makeToolCall({ toolCallId: 'e1', kind: 'edit', path: 'src/gone.ts', status: 'failed' })
    ])
    openPill()
    expect(
      await screen.findByRole('group', { name: 'Deleted: /work/src/gone.ts' })
    ).toBeInTheDocument()
  })

  it('opens the path a move call resolves', async () => {
    renderPanel([
      makeToolCall({
        toolCallId: 'm1',
        kind: 'move',
        content: [],
        rawInput: {},
        locations: [{ path: 'src/moved.ts' }]
      })
    ])
    openPill()
    fireEvent.click(await screen.findByRole('button', { name: '/work/src/moved.ts, Renamed' }))
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('/work/src/moved.ts')
      expect(addEditorTabRef.current).toHaveBeenCalledWith('/work/src/moved.ts')
    })
  })
})

describe('ChatStatusPill changed files on the desktop shell', () => {
  beforeEach(() => {
    mobileRef.current = false
  })

  it('opens a popover of the files with no tab bar and no Git action', () => {
    renderPanel(THREE_EDITS)
    expect(pill()).toHaveTextContent('3+3 −3')
    fireEvent.click(pill())
    const popover = screen.getByRole('dialog', { name: 'Changed files' })
    expect(popover).not.toHaveAttribute('data-sheet')
    expect(within(popover).queryByRole('tablist')).toBeNull()
    expect(within(popover).getByRole('button', { name: '/work/src/b.ts, Modified' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Open Git changes' })).toBeNull()
  })
})

describe('ChatStatusPill changed files on the phone shell', () => {
  beforeEach(() => {
    mobileRef.current = true
    openFileRef.current = vi.fn(async () => {})
    addEditorTabRef.current = vi.fn()
  })

  it('shows only the file count on the pill and the files in a bottom sheet', () => {
    renderPanel(THREE_EDITS)
    expect(pill()).toHaveTextContent(/^3$/)
    fireEvent.click(pill())
    const sheet = screen.getByRole('dialog', { name: 'Changed files' })
    expect(sheet).toHaveAttribute('data-sheet')
    expect(within(sheet).getByText('+3')).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: '/work/src/c.ts, Modified' })).toBeVisible()
  })

  it('hands the pill to the Git sheet as its opener and closes the files sheet', () => {
    const onOpenGitChanges = vi.fn()
    render(<Pill cwd="/work" toolCalls={THREE_EDITS} onOpenGitChanges={onOpenGitChanges} />)
    const trigger = pill()
    fireEvent.click(trigger)
    const sheet = screen.getByRole('dialog', { name: 'Changed files' })
    const git = within(sheet).getByRole('button', { name: 'Open Git changes' })
    expect(git).toHaveTextContent('Git')

    fireEvent.click(git)
    expect(onOpenGitChanges).toHaveBeenCalledTimes(1)
    expect(onOpenGitChanges).toHaveBeenCalledWith(trigger)
    expect(screen.queryByRole('dialog', { name: 'Changed files' })).toBeNull()
  })

  it('opens a file in the editor tab from a sheet row and closes the sheet', async () => {
    render(
      <Pill
        cwd="/work"
        toolCalls={[makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })]}
        onOpenGitChanges={vi.fn()}
      />
    )
    fireEvent.click(pill())
    fireEvent.click(await screen.findByRole('button', { name: /foo\.ts/i }))
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
      expect(addEditorTabRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
    })
    expect(screen.queryByRole('dialog', { name: 'Changed files' })).toBeNull()
  })
})

describe('ChatStatusPill changed files with git as the source of truth', () => {
  type Entry = [path: string, status: GitStatusDetail['status'], added: number, removed: number]

  /** What git reports for `/work` on the next status and diff-stat reads. */
  function setGit(entries: Entry[], staged: string[] = []) {
    const status: GitStatusDetail[] = entries.map(([path, s]) => ({
      path,
      status: s,
      staged: staged.includes(path)
    }))
    const stat: GitDiffStat = {
      added: entries.reduce((sum, [, , a]) => sum + a, 0),
      removed: entries.reduce((sum, [, , , r]) => sum + r, 0),
      files: entries.map(([path, , added, removed]) => ({ path, added, removed })),
      root: '/work'
    }
    gitApiMock.getStatus.mockResolvedValue(status)
    gitApiMock.getDiffStat.mockResolvedValue(stat)
  }

  const edit = (id: string, path: string) => makeToolCall({ toolCallId: id, path })
  const shell = (id: string, command: string) =>
    makeToolCall({ toolCallId: id, kind: 'execute', content: [], rawInput: { command } })

  function panel(toolCalls: ToolCall[], turnActive = false) {
    return <Pill cwd="/work" toolCalls={toolCalls} turnActive={turnActive} />
  }

  beforeEach(() => {
    mobileRef.current = false
    openFileRef.current = vi.fn(async () => {})
    addEditorTabRef.current = vi.fn()
    useGitStatusStore.setState({ errors: {} })
  })

  it('lists the uncommitted files of the checkout with their git line counts', async () => {
    setGit([
      ['src/a.ts', 'modified', 3, 1],
      ['src/new.ts', 'untracked', 5, 0]
    ])
    // The agent edited only a.ts; git also reports an untracked file.
    render(panel([edit('e1', 'src/a.ts')]))
    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(screen.getByText('+8')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    fireEvent.click(pill())
    const row = await screen.findByRole('button', { name: '/work/src/new.ts, Untracked' })
    expect(row).toHaveTextContent('+5')
  })

  it('drops files that the agent committed', async () => {
    setGit([
      ['src/a.ts', 'modified', 3, 1],
      ['src/b.ts', 'modified', 2, 0]
    ])
    const calls = [edit('e1', 'src/a.ts'), edit('e2', 'src/b.ts')]
    const { rerender } = render(panel(calls))
    expect(await screen.findByText('+5')).toBeInTheDocument()

    setGit([])
    rerender(panel([...calls, shell('x1', 'git commit -am "done" && git push')]))
    await waitFor(noPill, { timeout: 3000 })
  })

  it('drops a discarded file and updates the totals', async () => {
    setGit([
      ['src/a.ts', 'modified', 3, 1],
      ['src/b.ts', 'modified', 2, 0]
    ])
    render(panel([edit('e1', 'src/a.ts'), edit('e2', 'src/b.ts')]))
    expect(await screen.findByText('+5')).toBeInTheDocument()

    setGit([['src/b.ts', 'modified', 2, 0]])
    await act(() => useGitStatusStore.getState().discardFile('/work', 'src/a.ts'))
    expect(await screen.findByText('+2')).toBeInTheDocument()
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
    expect(screen.queryByText('−1')).not.toBeInTheDocument()
  })

  it('drops an untracked file after it is deleted', async () => {
    setGit([['scratch.md', 'untracked', 4, 0]])
    const calls = [edit('e1', 'scratch.md')]
    const { rerender } = render(panel(calls))
    expect(await screen.findByText('+4')).toBeInTheDocument()

    setGit([])
    rerender(
      panel([...calls, makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'scratch.md' })])
    )
    await waitFor(noPill, { timeout: 3000 })
  })

  it('refreshes when the agent turn ends', async () => {
    setGit([['src/a.ts', 'modified', 1, 0]])
    const calls = [edit('e1', 'src/a.ts')]
    const { rerender } = render(panel(calls, true))
    expect(await screen.findByText('+1')).toBeInTheDocument()

    setGit([])
    rerender(panel(calls, false))
    await waitFor(noPill, { timeout: 3000 })
  })

  it('hides on a clean tree even when the agent edited files earlier', async () => {
    setGit([])
    render(panel(THREE_EDITS))
    await waitFor(() => expect(gitApiMock.getStatus).toHaveBeenCalledWith('/work'))
    await act(async () => {})
    noPill()
  })

  it('updates when a refresh from another source changes git state', async () => {
    setGit([['src/a.ts', 'modified', 1, 0]])
    render(panel([edit('e1', 'src/a.ts')]))
    expect(await screen.findByText('+1')).toBeInTheDocument()

    setGit([])
    await act(() => useGitStatusStore.getState().refreshTracked())
    await waitFor(noPill)
  })

  it('shows one row for a file with staged and unstaged changes', async () => {
    gitApiMock.getStatus.mockResolvedValue([
      { path: 'src/a.ts', status: 'added', staged: true },
      { path: 'src/a.ts', status: 'modified', staged: false }
    ])
    gitApiMock.getDiffStat.mockResolvedValue({
      added: 7,
      removed: 0,
      files: [{ path: 'src/a.ts', added: 7, removed: 0 }]
    })
    render(panel([]))
    expect(await screen.findByText('1')).toBeInTheDocument()
    fireEvent.click(pill())
    expect(await screen.findByRole('button', { name: '/work/src/a.ts, Added' })).toBeInTheDocument()
  })

  it('shows a file deleted in git as a deleted row that does not open', async () => {
    setGit([['src/gone.ts', 'deleted', 0, 9]])
    render(panel([]))
    fireEvent.click(await screen.findByRole('button', { name: /^Session status:/ }))
    expect(
      await screen.findByRole('group', { name: 'Deleted: /work/src/gone.ts' })
    ).toBeInTheDocument()
  })

  it('opens a git row in the editor', async () => {
    setGit([['src/a.ts', 'modified', 1, 0]])
    render(panel([]))
    fireEvent.click(await screen.findByRole('button', { name: /^Session status:/ }))
    fireEvent.click(await screen.findByRole('button', { name: '/work/src/a.ts, Modified' }))
    await waitFor(() => expect(openFileRef.current).toHaveBeenCalledWith('/work/src/a.ts'))
  })

  it('resolves rows against the repository root when the cwd is a subfolder', async () => {
    seedNotARepo('/work/sub')
    useGitStatusStore.setState({ errors: {} })
    gitApiMock.getStatus.mockResolvedValue([
      { path: 'sub/file.ts', status: 'modified', staged: false },
      { path: 'top.ts', status: 'modified', staged: false }
    ])
    gitApiMock.getDiffStat.mockResolvedValue({
      added: 2,
      removed: 0,
      files: [
        { path: 'sub/file.ts', added: 1, removed: 0 },
        { path: 'top.ts', added: 1, removed: 0 }
      ],
      root: '/work'
    })
    render(<Pill cwd="/work/sub" toolCalls={[]} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Session status:/ }))
    expect(
      await screen.findByRole('button', { name: '/work/sub/file.ts, Modified' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '/work/top.ts, Modified' })).toBeInTheDocument()
  })

  it('still lists git rows against the cwd when the diff stat fails', async () => {
    gitApiMock.getStatus.mockResolvedValue([
      { path: 'src/a.ts', status: 'modified', staged: false }
    ])
    gitApiMock.getDiffStat.mockRejectedValue(new Error('diff stat timed out'))
    render(panel([]))
    fireEvent.click(await screen.findByRole('button', { name: /^Session status:/ }))
    expect(
      await screen.findByRole('button', { name: '/work/src/a.ts, Modified' })
    ).toBeInTheDocument()
  })

  it('falls back to the agent tool calls when the cwd is not a git repository', async () => {
    seedNotARepo('/work')
    render(panel([edit('e1', 'src/a.ts')]))
    expect(pill()).toHaveAccessibleName('Session status: 1 changed file')
    await waitFor(() =>
      expect(logFrontendErrorRef.current).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'info', source: 'useGitChangedFiles' })
      )
    )
  })
})
