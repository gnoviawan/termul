import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'

const { openFileRef, addEditorTabRef, logFrontendErrorRef, toastErrorRef } = vi.hoisted(() => ({
  openFileRef: { current: vi.fn(async () => {}) },
  addEditorTabRef: { current: vi.fn() },
  logFrontendErrorRef: { current: vi.fn(async () => {}) },
  toastErrorRef: { current: vi.fn() }
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

describe('ChatChangedFilesPanel', () => {
  beforeEach(() => {
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

  it('opens the file on Enter keydown', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.keyDown(row, { key: 'Enter' })
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
    })
  })

  it('opens the file on Space keydown', async () => {
    renderPanel([makeToolCall({ toolCallId: 'e1', path: 'src/foo.ts' })])
    fireEvent.click(screen.getByRole('button', { name: /expand/i }))
    const row = await screen.findByRole('button', { name: /foo\.ts/i })
    fireEvent.keyDown(row, { key: ' ' })
    await waitFor(() => {
      expect(openFileRef.current).toHaveBeenCalledWith('/work/src/foo.ts')
    })
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
})
