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
    expect(await screen.findByText('src/foo.ts')).toBeInTheDocument()
    expect(screen.getByText('src/bar.ts')).toBeInTheDocument()
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

  it('shows the full inline path for nested files', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(await screen.findByText('src/foo.ts')).toBeInTheDocument()
  })

  it('shows per-file +/- counts when expanded', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    await screen.findByText('src/foo.ts')
    expect(screen.getAllByText('+1').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('−1').length).toBeGreaterThanOrEqual(2)
  })

  it('deduplicates files touched by multiple tool calls to the same path', () => {
    renderPanel([
      makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' }),
      makeToolCall({ toolCallId: 'e2', path: 'src/foo.ts' })
    ])
    expect(screen.getByText('2')).toBeInTheDocument()
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
    expect(screen.getByText('src/from-locations.ts')).toBeInTheDocument()
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
    // The Git action is its own control: tapping it does not toggle the panel.
    expect(screen.getByRole('button', { name: /^Changed files/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
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
