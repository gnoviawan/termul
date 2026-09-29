import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsTauriContext, mockOnEvent } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(),
  mockOnEvent: vi.fn(() => vi.fn())
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

vi.mock('@/lib/acp-transport', () => ({
  getAcpTransport: () => ({ onEvent: mockOnEvent })
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn(() => Promise.resolve())
}))

import { useWorktreeProgressStore } from './worktree-progress-store'

const store = () => useWorktreeProgressStore.getState()

describe('worktree-progress-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    useWorktreeProgressStore.setState({ ops: {} })
  })

  it('begin registers an op in the preparing state', () => {
    store().begin('p1', 'chat/abc12345')
    const op = store().ops.p1
    expect(op.status).toBe('preparing')
    expect(op.branch).toBe('chat/abc12345')
    expect(op.lines).toEqual([])
    expect(op.percent).toBeNull()
  })

  it('appendLine flips preparing → running and records lines', () => {
    store().begin('p1')
    store().appendLine('p1', 'Preparing worktree (new branch)')
    const op = store().ops.p1
    expect(op.status).toBe('running')
    expect(op.lines).toEqual(['Preparing worktree (new branch)'])
  })

  it('parses Updating files percent into op.percent', () => {
    store().begin('p1')
    store().appendLine('p1', 'Updating files:  42% (1234/5678)')
    expect(store().ops.p1.percent).toBe(42)
  })

  it('collapses consecutive Updating files lines into the latest value', () => {
    store().begin('p1')
    store().appendLine('p1', 'Preparing worktree')
    store().appendLine('p1', 'Updating files:  10% (1/10)')
    store().appendLine('p1', 'Updating files:  90% (9/10)')
    const op = store().ops.p1
    expect(op.lines).toEqual(['Preparing worktree', 'Updating files:  90% (9/10)'])
    expect(op.percent).toBe(90)
  })

  it('does not collapse non-consecutive Updating files lines', () => {
    store().begin('p1')
    store().appendLine('p1', 'Updating files:  10% (1/10)')
    store().appendLine('p1', 'unrelated line')
    store().appendLine('p1', 'Updating files:  50% (5/10)')
    expect(store().ops.p1.lines).toHaveLength(3)
  })

  it('caps lines at 200 and counts dropped lines', () => {
    store().begin('p1')
    for (let i = 0; i < 250; i++) store().appendLine('p1', `line ${i}`)
    const op = store().ops.p1
    expect(op.lines).toHaveLength(200)
    expect(op.dropped).toBe(50)
    expect(op.lines[0]).toBe('line 50')
  })

  it('finish marks the op done', () => {
    store().begin('p1')
    store().finish('p1')
    expect(store().ops.p1.status).toBe('done')
    expect(store().ops.p1.error).toBeNull()
  })

  it('finish with a message marks the op error', () => {
    store().begin('p1')
    store().finish('p1', 'boom')
    const op = store().ops.p1
    expect(op.status).toBe('error')
    expect(op.error).toBe('boom')
  })

  it('handleEvent routes lines and sentinels by progressId', () => {
    store().begin('p1')
    store().handleEvent({ progressId: 'p1', line: 'preparing' })
    expect(store().ops.p1.lines).toEqual([]) // sentinel skipped
    store().handleEvent({ progressId: 'p1', line: 'Updating files:  5%' })
    expect(store().ops.p1.lines).toEqual(['Updating files:  5%'])
    store().handleEvent({ progressId: 'p1', line: 'done' })
    expect(store().ops.p1.status).toBe('done')
  })

  it('handleEvent maps error: sentinel to the error state', () => {
    store().begin('p1')
    store().handleEvent({ progressId: 'p1', line: 'error: branch exists' })
    const op = store().ops.p1
    expect(op.status).toBe('error')
    expect(op.error).toBe('branch exists')
    expect(op.lines).toContain('error: branch exists')
  })

  it('handleEvent ignores unknown progressIds (cross-launch isolation)', () => {
    store().handleEvent({ progressId: 'nope', line: 'Updating files:  1%' })
    expect(store().ops.nope).toBeUndefined()
  })

  it('clear removes the op', () => {
    store().begin('p1')
    store().clear('p1')
    expect(store().ops.p1).toBeUndefined()
  })

  it('ensureTransportListener is a no-op off Tauri (web progress rides the NDJSON response)', () => {
    mockIsTauriContext.mockReturnValue(false)
    store().ensureTransportListener()
    expect(mockOnEvent).not.toHaveBeenCalled()
  })

  // NOTE: must run after the web no-op test — module-level `transportUnlisten`
  // persists once armed.
  it('ensureTransportListener subscribes to acp:worktree_progress once on Tauri', () => {
    mockIsTauriContext.mockReturnValue(true)
    store().ensureTransportListener()
    store().ensureTransportListener()
    expect(mockOnEvent).toHaveBeenCalledTimes(1)
    expect(mockOnEvent).toHaveBeenCalledWith('acp:worktree_progress', expect.any(Function))
  })
})
