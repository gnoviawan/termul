import type { TerminalsWatchState } from '@shared/types/web-protocol.types'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchHandlers } from '@/lib/acp-transport/watch-client'

const { mockTransport } = vi.hoisted(() => ({
  mockTransport: { watches: undefined as unknown }
}))
vi.mock('@/lib/acp-transport', () => ({ getAcpTransport: () => mockTransport }))

import { useWebTerminalSet } from './use-web-terminal-set'

const entry = (terminalId: string, attached = true) => ({
  terminalId,
  projectId: 'p1',
  cwd: '/work',
  attached
})

describe('useWebTerminalSet', () => {
  let handlers: WatchHandlers<TerminalsWatchState, TerminalsWatchState> | null = null
  const release = vi.fn()
  const subscribe = vi.fn(
    (
      _watch: string,
      h: WatchHandlers<TerminalsWatchState, TerminalsWatchState>,
      _scope?: string
    ) => {
      handlers = h
      return release
    }
  )

  beforeEach(() => {
    handlers = null
    release.mockClear()
    subscribe.mockClear()
    mockTransport.watches = { subscribe }
  })

  it('replaces the set with every state and delta, scoped to the project', () => {
    const { result } = renderHook(() => useWebTerminalSet('p1'))
    expect(subscribe).toHaveBeenCalledWith('terminals', expect.any(Object), 'p1')
    expect(result.current).toEqual([])

    act(() => handlers?.onState({ terminals: [entry('t1'), entry('t2', false)] }))
    expect(result.current.map((t) => t.terminalId)).toEqual(['t1', 't2'])

    act(() => handlers?.onDelta?.({ terminals: [entry('t2', false)] }))
    expect(result.current.map((t) => t.terminalId)).toEqual(['t2'])
  })

  it('releases the watch and clears the set when the project changes', () => {
    const { result, rerender } = renderHook(({ id }) => useWebTerminalSet(id), {
      initialProps: { id: 'p1' as string | null }
    })
    act(() => handlers?.onState({ terminals: [entry('t1')] }))
    rerender({ id: null })
    expect(release).toHaveBeenCalledTimes(1)
    expect(result.current).toEqual([])
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('stays empty when the transport has no watches (desktop)', () => {
    mockTransport.watches = undefined
    const { result } = renderHook(() => useWebTerminalSet('p1'))
    expect(result.current).toEqual([])
    expect(subscribe).not.toHaveBeenCalled()
  })
})
