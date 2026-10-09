import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { LeafNode, PaneNode, SplitNode } from '@/types/workspace.types'
import { resolveMobileActiveLeaf, useMobileActiveLeaf } from './use-mobile-active-leaf'

const { mockLogFrontendError } = vi.hoisted(() => ({ mockLogFrontendError: vi.fn() }))

vi.mock('@/lib/log-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log-api')>()),
  logFrontendError: mockLogFrontendError
}))

function leaf(id: string): LeafNode {
  return {
    type: 'leaf',
    id,
    tabs: [{ type: 'git', id: `git-${id}`, cwd: `/${id}` }],
    activeTabId: `git-${id}`
  }
}

function split(id: string, children: PaneNode[]): SplitNode {
  return {
    type: 'split',
    id,
    direction: 'horizontal',
    children,
    sizes: children.map(() => 100 / children.length)
  }
}

function unresolvedWarnings(): unknown[][] {
  return mockLogFrontendError.mock.calls.filter(
    ([payload]) => (payload as { source?: string }).source === 'useMobileActiveLeaf'
  )
}

describe('resolveMobileActiveLeaf', () => {
  it('returns the leaf whose id is activePaneId', () => {
    const a = leaf('a')
    const b = leaf('b')
    const root = split('s', [a, b])

    expect(resolveMobileActiveLeaf(root, 'b')).toEqual({ leaf: b, fallback: false })
    expect(resolveMobileActiveLeaf(root, 'a')).toEqual({ leaf: a, fallback: false })
    // The very same leaf object, not a copy.
    expect(resolveMobileActiveLeaf(root, 'b').leaf).toBe(b)
  })

  it('finds an active leaf inside nested splits', () => {
    const deep = leaf('deep')
    const root = split('outer', [
      leaf('a'),
      { ...split('inner', [leaf('b'), deep]), direction: 'vertical' }
    ])

    expect(resolveMobileActiveLeaf(root, 'deep')).toEqual({ leaf: deep, fallback: false })
  })

  it('returns a single-leaf root as is', () => {
    const only = leaf('only')

    expect(resolveMobileActiveLeaf(only, 'only')).toEqual({ leaf: only, fallback: false })
  })

  it('falls back to the first leaf when activePaneId matches no leaf', () => {
    const a = leaf('a')
    const root = split('s', [a, leaf('b')])

    expect(resolveMobileActiveLeaf(root, 'ghost')).toEqual({ leaf: a, fallback: true })
    expect(resolveMobileActiveLeaf(root, '')).toEqual({ leaf: a, fallback: true })
    expect(resolveMobileActiveLeaf(root, null)).toEqual({ leaf: a, fallback: true })
    expect(resolveMobileActiveLeaf(root, undefined)).toEqual({ leaf: a, fallback: true })
  })

  it('treats a split id as unresolved (only leaves can be active)', () => {
    const a = leaf('a')
    const root = split('s', [a, leaf('b')])

    expect(resolveMobileActiveLeaf(root, 's')).toEqual({ leaf: a, fallback: true })
  })

  it('returns no leaf for a degenerate tree without leaves', () => {
    expect(resolveMobileActiveLeaf(split('empty', []), 'x')).toEqual({ leaf: null, fallback: true })
  })

  it('does not mutate the tree', () => {
    const root = split('s', [leaf('a'), leaf('b')])
    const snapshot = JSON.parse(JSON.stringify(root))

    resolveMobileActiveLeaf(root, 'b')
    resolveMobileActiveLeaf(root, 'ghost')

    expect(root).toEqual(snapshot)
  })
})

describe('useMobileActiveLeaf', () => {
  const a = leaf('a')
  const b = leaf('b')
  const root = split('s', [a, b])

  beforeEach(() => {
    mockLogFrontendError.mockClear()
    useWorkspaceStore.setState({
      root,
      activePaneId: 'b',
      fullscreenPaneId: null,
      agentLauncherPaneId: null
    })
  })

  it('returns null and logs nothing when disabled', () => {
    const { result } = renderHook(() => useMobileActiveLeaf(false))

    expect(result.current).toBeNull()
    expect(unresolvedWarnings()).toHaveLength(0)
  })

  it('returns the active leaf of a split when enabled', () => {
    const { result } = renderHook(() => useMobileActiveLeaf(true))

    expect(result.current).toBe(b)
    expect(unresolvedWarnings()).toHaveLength(0)
  })

  it('follows activePaneId changes and returns null again when disabled', () => {
    const { result, rerender } = renderHook(({ enabled }) => useMobileActiveLeaf(enabled), {
      initialProps: { enabled: true }
    })
    expect(result.current).toBe(b)

    act(() => {
      useWorkspaceStore.setState({ activePaneId: 'a' })
    })
    expect(result.current).toBe(a)

    rerender({ enabled: false })
    expect(result.current).toBeNull()
  })

  it('is read-only: it never writes to the workspace store', () => {
    // An unresolved id exercises the fallback path too.
    useWorkspaceStore.setState({ activePaneId: 'ghost' })
    const listener = vi.fn()
    const unsubscribe = useWorkspaceStore.subscribe(listener)

    const { rerender } = renderHook(() => useMobileActiveLeaf(true))
    rerender()

    expect(listener).not.toHaveBeenCalled()
    const state = useWorkspaceStore.getState()
    expect(state.root).toBe(root)
    expect(state.activePaneId).toBe('ghost')
    expect(state.fullscreenPaneId).toBeNull()
    unsubscribe()
  })

  it('falls back to the first leaf and warns once per distinct unresolved id', () => {
    useWorkspaceStore.setState({ activePaneId: 'ghost-1' })
    const { result, rerender } = renderHook(() => useMobileActiveLeaf(true))

    expect(result.current).toBe(a)
    expect(unresolvedWarnings()).toHaveLength(1)
    expect(unresolvedWarnings()[0][0]).toEqual(
      expect.objectContaining({ level: 'warn', source: 'useMobileActiveLeaf' })
    )
    expect(JSON.stringify(unresolvedWarnings()[0][0])).toContain('ghost-1')

    // Re-renders with the same unresolved id stay silent.
    rerender()
    rerender()
    expect(unresolvedWarnings()).toHaveLength(1)

    // A different unresolved id warns again.
    act(() => {
      useWorkspaceStore.setState({ activePaneId: 'ghost-2' })
    })
    expect(result.current).toBe(a)
    expect(unresolvedWarnings()).toHaveLength(2)

    // Recovering, then hitting an already-reported id again, stays silent.
    act(() => {
      useWorkspaceStore.setState({ activePaneId: 'b' })
    })
    expect(result.current).toBe(b)
    act(() => {
      useWorkspaceStore.setState({ activePaneId: 'ghost-1' })
    })
    expect(result.current).toBe(a)
    expect(unresolvedWarnings()).toHaveLength(2)
  })

  it('does not warn while disabled even if activePaneId is unresolved', () => {
    useWorkspaceStore.setState({ activePaneId: 'ghost' })

    renderHook(() => useMobileActiveLeaf(false))

    expect(unresolvedWarnings()).toHaveLength(0)
  })
})
