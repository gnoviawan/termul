import type { GitStatusDetail } from '@shared/types/ipc.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  statusesRef,
  refreshStatusRef,
  openFileRef,
  addEditorTabRef,
  logFrontendErrorRef,
  toastErrorRef
} = vi.hoisted(() => ({
  statusesRef: { current: [] as GitStatusDetail[] },
  refreshStatusRef: { current: vi.fn(async () => {}) },
  openFileRef: { current: vi.fn(async () => {}) },
  addEditorTabRef: { current: vi.fn() },
  logFrontendErrorRef: { current: vi.fn(async () => {}) },
  toastErrorRef: { current: vi.fn() }
}))

vi.mock('@/stores/git-status-store', () => ({
  useGitStatusStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      statuses: new Proxy(
        { '/work': statusesRef.current },
        { get: () => statusesRef.current }
      ),
      refreshStatus: refreshStatusRef.current
    })
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

const REFRESH_INTERVAL_MS = 3000

function renderPanel(overrides: { cwd?: string; activeTurn?: boolean } = {}) {
  return render(
    <ChatChangedFilesPanel
      cwd={overrides.cwd ?? '/work'}
      activeTurn={overrides.activeTurn ?? true}
    />
  )
}

const MODIFIED: GitStatusDetail = { path: 'src/foo.ts', status: 'modified', staged: false }
const ADDED: GitStatusDetail = { path: 'src/new.ts', status: 'added', staged: true }
const DELETED: GitStatusDetail = { path: 'old.ts', status: 'deleted', staged: false }

describe('ChatChangedFilesPanel', () => {
  beforeEach(() => {
    statusesRef.current = []
    refreshStatusRef.current = vi.fn(async () => {})
    openFileRef.current = vi.fn(async () => {})
    addEditorTabRef.current = vi.fn()
    logFrontendErrorRef.current = vi.fn(async () => {})
    toastErrorRef.current = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders the header with a count badge when turn is active and files exist', () => {
    statusesRef.current = [MODIFIED, ADDED]
    renderPanel()
    expect(screen.getByText('Changed files')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('shows "No changes" when count is 0', () => {
    renderPanel()
    expect(screen.getByText('No changes')).toBeInTheDocument()
  })

  it('does not call refreshStatus when activeTurn is false', () => {
    renderPanel({ activeTurn: false })
    expect(refreshStatusRef.current).not.toHaveBeenCalled()
  })

  it('calls refreshStatus on mount when activeTurn is true', () => {
    renderPanel()
    expect(refreshStatusRef.current).toHaveBeenCalledWith('/work')
  })

  it('expands and shows file rows on header click', async () => {
    statusesRef.current = [MODIFIED, ADDED]
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(await screen.findByText('foo.ts')).toBeInTheDocument()
    expect(screen.getByText('new.ts')).toBeInTheDocument()
  })

  it('shows "No changes detected" in the empty state when expanded', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(await screen.findByText('No changes detected')).toBeInTheDocument()
  })

  it('opens the file in the editor when a row is clicked', async () => {
    statusesRef.current = [MODIFIED]
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.click(row)
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
      expect(addEditorTabRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
    })
  })

  it('opens the file on Enter keydown', async () => {
    statusesRef.current = [MODIFIED]
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.keyDown(row, { key: 'Enter' })
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
    })
  })

  it('opens the file on Space keydown', async () => {
    statusesRef.current = [MODIFIED]
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.keyDown(row, { key: ' ' })
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
    })
  })

  it('normalizes backslash cwd separators when opening files', async () => {
    statusesRef.current = [MODIFIED]
    renderPanel({ cwd: 'E:\\repo' })
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.click(row)
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('E:/repo/src/foo.ts')
    })
  })

  it('logs but does not toast when refreshStatus fails', async () => {
    refreshStatusRef.current = vi.fn(async () => {
      throw new Error('git error')
    })
    renderPanel()
    await waitFor(() => {
      expect(logFrontendErrorRef.current).toHaveBeenCalled()
    })
  })

  it('toasts and logs when openFile fails', async () => {
    statusesRef.current = [MODIFIED]
    openFileRef.current = vi.fn(async () => {
      throw new Error('read error')
    })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.click(row)
    await waitFor(() => {
      expect(toastErrorRef.current).toHaveBeenCalledWith('Could not open file')
      expect(logFrontendErrorRef.current).toHaveBeenCalled()
    })
    expect(addEditorTabRef.current).not.toHaveBeenCalled()
  })

  it('renders the correct status badge icon for each status', async () => {
    statusesRef.current = [MODIFIED, ADDED, DELETED]
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    await screen.findByText('foo.ts')
    expect(screen.getByTitle('Modified')).toBeInTheDocument()
    expect(screen.getByTitle('Added')).toBeInTheDocument()
    expect(screen.getByTitle('Deleted')).toBeInTheDocument()
  })

  it('shows the directory subtitle for nested paths', async () => {
    statusesRef.current = [MODIFIED]
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    expect(await screen.findByText('src')).toBeInTheDocument()
  })

  it('polls refreshStatus on a timer while expanded', async () => {
    vi.useFakeTimers()
    refreshStatusRef.current = vi.fn(async () => {})
    renderPanel()
    expect(refreshStatusRef.current).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS + 100)
    expect(refreshStatusRef.current).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS + 100)
    expect(refreshStatusRef.current).toHaveBeenCalledTimes(3)
  })

  it('stops polling when collapsed', async () => {
    vi.useFakeTimers()
    refreshStatusRef.current = vi.fn(async () => {})
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS + 100)
    const callsAfterExpand = refreshStatusRef.current.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /collapse/i }))
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3)
    expect(refreshStatusRef.current.mock.calls.length).toBe(callsAfterExpand)
  })

  it('clears the timeout on unmount', async () => {
    vi.useFakeTimers()
    refreshStatusRef.current = vi.fn(async () => {})
    const { unmount } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    unmount()
    const callsAtUnmount = refreshStatusRef.current.mock.calls.length
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 5)
    expect(refreshStatusRef.current.mock.calls.length).toBe(callsAtUnmount)
  })
})
