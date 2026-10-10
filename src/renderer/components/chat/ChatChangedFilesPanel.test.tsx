import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'

const { openFileRef, addEditorTabRef, logFrontendErrorRef, toastErrorRef, mobileRef } = vi.hoisted(
  () => ({
    openFileRef: { current: vi.fn(async () => {}) },
    addEditorTabRef: { current: vi.fn() },
    logFrontendErrorRef: { current: vi.fn(async () => {}) },
    toastErrorRef: { current: vi.fn() },
    mobileRef: { current: false }
  })
)

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

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: (...args: unknown[]) => toastErrorRef.current(...args)
  })
}))

import { ChatChangedFilesPanel } from './ChatChangedFilesPanel'

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
  return render(<ChatChangedFilesPanel cwd={cwd} toolCalls={toolCalls} />)
}

const THREE_EDITS = [
  makeToolCall({ toolCallId: 'e1', path: 'src/a.ts' }),
  makeToolCall({ toolCallId: 'e2', path: 'src/b.ts' }),
  makeToolCall({ toolCallId: 'e3', path: 'src/c.ts' })
]

describe('ChatChangedFilesPanel', () => {
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
    const { container } = renderPanel([])
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for non-edit tool calls (read, search, execute)', () => {
    const { container } = renderPanel([
      makeToolCall({ toolCallId: 'r1', kind: 'read', path: 'src/a.ts' }),
      makeToolCall({ toolCallId: 's1', kind: 'search', path: 'src/b.ts' })
    ])
    expect(container.firstChild).toBeNull()
  })

  it('renders the header with count badge when edit tool calls exist', () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
      makeToolCall({ toolCallId: 'e2', path: 'src/bar.ts' })
    ])
    expect(screen.getByText('Changed files')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(await screen.findByText('foo.ts')).toBeInTheDocument()
    expect(screen.getByText('bar.ts')).toBeInTheDocument()
  })

  it('opens the file in the editor when a row is clicked', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.click(row)
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
      expect(addEditorTabRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
    })
  })

  it('uses a native button for each file row', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    expect(row.tagName).toBe('BUTTON')
    expect(row).toHaveAttribute('type', 'button')
  })

  it('normalizes backslash cwd separators when opening files', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })], 'E:\\repo')
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
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
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('merges a lowercase-drive path with a cwd-relative one', async () => {
    renderPanel(
      [
        makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
        makeToolCall({ toolCallId: 'e2', path: 'e:/repo/src/foo.ts' })
      ],
      'E:\\repo'
    )
    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.click(row)
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('E:/repo/src/foo.ts')
    })
  })

  it('keeps the UNC prefix when resolving a relative path against a UNC cwd', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })], '\\\\server\\share\\repo')
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
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
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
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
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
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
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    expect(row).toHaveAttribute('title', '/work/foo.ts')
    expect(screen.getByText('foo.ts')).toBeInTheDocument()
    // No directory part → no dimmed subtitle span.
    expect(row.querySelector('.text-4xs')).toBeNull()
  })

  it('shows per-file +/- counts when expanded', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
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
    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    // Exactly one row (findByText throws on multiple matches) showing +3 −3.
    await screen.findByText('foo.ts')
    // One occurrence in the row, one in the header totals.
    expect(screen.getAllByText('+3')).toHaveLength(2)
    expect(screen.getAllByText('−3')).toHaveLength(2)
  })

  it('merges a relative and an absolute path to the same file under cwd', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
      makeToolCall({ toolCallId: 'e2', path: '/work/src/foo.ts' })
    ])
    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
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
    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
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
    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(await screen.findByText('b.ts')).toBeInTheDocument()
  })

  it('collapses a delete followed by a recreate edit into one row', async () => {
    renderPanel([
      makeToolCall({ toolCallId: 'd1', kind: 'delete', path: 'a.ts', content: [] }),
      makeToolCall({ toolCallId: 'e1', kind: 'edit', path: 'a.ts' })
    ])
    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
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
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /a\.ts/i })
    expect(row).toHaveTextContent('+5')
    expect(row).toHaveTextContent('−2')
  })

  it('keeps first-appearance order when a file is touched again later', async () => {
    const { container } = renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'b.ts' }),
      makeToolCall({ toolCallId: 'e2', path: 'a.ts' }),
      makeToolCall({ toolCallId: 'e3', path: 'b.ts' })
    ])
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    await screen.findByText('b.ts')
    const titles = Array.from(container.querySelectorAll('button[title]')).map((el) =>
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
    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    // The row's aria-label carries the canonical resolved path.
    expect(await screen.findByRole('button', { name: '/work/src/foo.ts' })).toBeInTheDocument()
  })

  it('skips a whitespace-only tool-call path', () => {
    const { container } = renderPanel([
      makeToolCall({
        toolCallId: 'e1',
        rawInput: {},
        content: [],
        locations: [{ path: '   ' }]
      })
    ])
    expect(container.firstChild).toBeNull()
  })

  it('shows the absolute directory subtitle for a file outside cwd', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: '/etc/hosts' })])
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: '/etc/hosts' })
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
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('persists across agent replies (does not clear on turn end)', () => {
    // The panel has no activeTurn prop — it shows whenever toolCalls exist.
    // This test confirms the design: no activeTurn gating.
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    expect(screen.getByText('Changed files')).toBeInTheDocument()
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
    expect(screen.getByText('Changed files')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('prefers locations path over rawInput path', () => {
    renderPanel([
      makeToolCall({
        toolCallId: 'e1',
        rawInput: { filePath: 'src/from-input.ts' },
        locations: [{ path: 'src/from-locations.ts' }]
      })
    ])
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
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
    expect(screen.getByText('Changed files')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    await screen.findByText('a.ts')
    // One occurrence in the row, one in the header totals.
    expect(screen.getAllByText('+5')).toHaveLength(2)
    expect(screen.getAllByText('\u22121')).toHaveLength(2)
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
    expect(screen.getByText('Changed files')).toBeInTheDocument()
  })
})

describe('ChatChangedFilesPanel on the desktop shell', () => {
  beforeEach(() => {
    mobileRef.current = false
  })

  it('keeps the Expand/Collapse names and renders no Git action without onOpenGitChanges', () => {
    renderPanel(THREE_EDITS)
    const header = screen.getByRole('button', { name: 'Expand changed files' })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Open Git changes' })).not.toBeInTheDocument()

    fireEvent.click(header)
    expect(screen.getByRole('button', { name: 'Collapse changed files' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })
})

describe('ChatChangedFilesPanel on the mobile dock', () => {
  beforeEach(() => {
    mobileRef.current = true
    openFileRef.current = vi.fn(async () => {})
    addEditorTabRef.current = vi.fn()
  })

  it('names the header by its visible text plus aria-expanded (no overriding aria-label)', () => {
    renderPanel(THREE_EDITS)
    const header = screen.getByRole('button', { name: 'Changed files 3 +3 −3' })
    expect(header).not.toHaveAttribute('aria-label')
    expect(header).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
  })

  it('adds a ghost xs "Git" action named "Open Git changes" with a 44px hit area', () => {
    const onOpenGitChanges = vi.fn()
    render(
      <ChatChangedFilesPanel
        cwd="/work"
        toolCalls={THREE_EDITS}
        onOpenGitChanges={onOpenGitChanges}
      />
    )
    const git = screen.getByRole('button', { name: 'Open Git changes' })
    expect(git).toHaveTextContent('Git')
    expect(git.className).toContain('h-7')
    expect(git.className).toContain('after:-inset-2')
    expect(git.className).toContain('relative')
    expect(git.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')

    fireEvent.click(git)
    expect(onOpenGitChanges).toHaveBeenCalledTimes(1)
    // The tapped button is handed over, so the Git sheet can return focus to it.
    expect(onOpenGitChanges).toHaveBeenCalledWith(git)
    // The Git action is its own control: tapping it does not toggle the panel.
    expect(screen.getByRole('button', { name: /^Changed files/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  // jsdom has no layout, so this pins the class tokens that give the collapsed
  // bar a 44px strip (measured in tests/e2e/mobile-chat-dock-approvals.spec.ts:
  // 33px with `pt-2 pb-8`, which left the Git hit area short of 44px).
  it('gives the collapsed bar a taller tap strip only when the Git action is shown', () => {
    const { unmount } = render(
      <ChatChangedFilesPanel cwd="/work" toolCalls={THREE_EDITS} onOpenGitChanges={vi.fn()} />
    )
    const withGit = screen.getByRole('button', { name: /^Changed files/ })
    expect(withGit.className).toContain('pt-4')
    expect(withGit.className).toContain('pb-9')
    expect(withGit.className).not.toContain('pb-8')
    expect(screen.getByRole('button', { name: 'Open Git changes' }).className).toContain('mt-2')

    // Expanded: the header is back to plain vertical padding.
    fireEvent.click(withGit)
    expect(withGit.className).toContain('py-2')
    expect(withGit.className).not.toContain('pb-9')
    unmount()

    render(<ChatChangedFilesPanel cwd="/work" toolCalls={THREE_EDITS} />)
    const withoutGit = screen.getByRole('button', { name: /^Changed files/ })
    expect(withoutGit.className).toContain('pb-8')
    expect(withoutGit.className).not.toContain('pb-9')
  })

  it('does not nest the Git action inside the header toggle', () => {
    render(<ChatChangedFilesPanel cwd="/work" toolCalls={THREE_EDITS} onOpenGitChanges={vi.fn()} />)
    const header = screen.getByRole('button', { name: /^Changed files/ })
    expect(header.querySelector('button')).toBeNull()
    expect(header).not.toContainElement(screen.getByRole('button', { name: 'Open Git changes' }))
  })

  it('still opens a file in the editor tab from an expanded row', async () => {
    render(
      <ChatChangedFilesPanel
        cwd="/work"
        toolCalls={[makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })]}
        onOpenGitChanges={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Changed files/ }))
    fireEvent.click(await screen.findByRole('button', { name: /foo\.ts/i }))
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
      expect(addEditorTabRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
    })
  })

  it('renders collapsed while forceCollapsed, flips on a header tap, then shows the user state', async () => {
    const { rerender } = render(<ChatChangedFilesPanel cwd="/work" toolCalls={THREE_EDITS} />)
    const header = (): HTMLElement => screen.getByRole('button', { name: /^Changed files/ })
    fireEvent.click(header())
    expect(header()).toHaveAttribute('aria-expanded', 'true')

    rerender(<ChatChangedFilesPanel cwd="/work" toolCalls={THREE_EDITS} forceCollapsed />)
    expect(header()).toHaveAttribute('aria-expanded', 'false')

    // A header tap during the window flips the rendered state (to expanded).
    fireEvent.click(header())
    expect(header()).toHaveAttribute('aria-expanded', 'true')

    // And back: tapping again collapses it for the rest of the window.
    fireEvent.click(header())
    expect(header()).toHaveAttribute('aria-expanded', 'false')

    // Window over: the bar shows the user's last own state (collapsed).
    rerender(<ChatChangedFilesPanel cwd="/work" toolCalls={THREE_EDITS} forceCollapsed={false} />)
    expect(header()).toHaveAttribute('aria-expanded', 'false')
  })
})
