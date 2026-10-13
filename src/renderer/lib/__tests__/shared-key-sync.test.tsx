import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syncSharedKey, useSharedKeySync } from '../shared-key-sync'
import { sharedFake } from './shared-watch-fake'

vi.mock('@/lib/api', async () => ({
  persistenceApi: (await import('./shared-watch-fake')).sharedFake.api
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

describe('shared key sync', () => {
  beforeEach(() => {
    sharedFake.reset()
  })

  it('hands every remote change of the key to apply, and never writes', () => {
    const apply = vi.fn()
    syncSharedKey('settings/app', apply)

    sharedFake.remote('settings/app', { theme: 'light' })
    sharedFake.remoteDelete('settings/app')

    expect(apply.mock.calls).toEqual([
      [{ exists: true, data: { theme: 'light' } }],
      [{ exists: false }]
    ])
    expect(sharedFake.api.write).not.toHaveBeenCalled()
    expect(sharedFake.api.writeDebounced).not.toHaveBeenCalled()
  })

  it('ignores changes of other keys', () => {
    const apply = vi.fn()
    syncSharedKey('settings/app', apply)
    sharedFake.remote('settings/toc', { a: 1 })
    expect(apply).not.toHaveBeenCalled()
  })

  it('keeps going when apply throws', () => {
    const apply = vi.fn().mockImplementationOnce(() => {
      throw new Error('boom')
    })
    syncSharedKey('settings/app', apply)
    sharedFake.remote('settings/app', 1)
    sharedFake.remote('settings/app', 2)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the facade has no watch', () => {
    const watch = sharedFake.api.watchShared
    ;(sharedFake.api as { watchShared?: unknown }).watchShared = undefined
    try {
      const apply = vi.fn()
      const stop = syncSharedKey('settings/app', apply)
      expect(stop).not.toThrow()
      expect(apply).not.toHaveBeenCalled()
    } finally {
      sharedFake.api.watchShared = watch
    }
  })

  it('hook: watches while mounted, uses the latest apply, and stops on unmount', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender, unmount } = renderHook(
      ({ apply }) => useSharedKeySync('settings/app', apply),
      { initialProps: { apply: first } }
    )
    expect(sharedFake.watcherCount('settings/app')).toBe(1)

    rerender({ apply: second })
    expect(sharedFake.watcherCount('settings/app')).toBe(1)
    sharedFake.remote('settings/app', { v: 1 })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith({ exists: true, data: { v: 1 } })

    unmount()
    expect(sharedFake.watcherCount('settings/app')).toBe(0)
    sharedFake.remote('settings/app', { v: 2 })
    expect(second).toHaveBeenCalledTimes(1)
  })
})
