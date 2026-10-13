import { act, renderHook, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sshApi } = vi.hoisted(() => ({
  sshApi: { sftpListDir: vi.fn(), sftpRealpath: vi.fn() }
}))
vi.mock('@/lib/api', () => ({ sshApi }))

import { joinPath, parentPath, useSftpBrowser } from './use-sftp-browser'

const entry = (name: string, entryType: 'file' | 'directory' = 'file') => ({
  name,
  path: `/home/u/${name}`,
  entryType,
  size: 1,
  permissions: 0,
  modifiedAt: ''
})

beforeEach(() => {
  vi.clearAllMocks()
  sshApi.sftpRealpath.mockResolvedValue({ success: true, data: '/home/u' })
  sshApi.sftpListDir.mockImplementation(async (_id: string, path: string) => ({
    success: true,
    data: path === '/home/u' ? [entry('docs', 'directory'), entry('a.txt')] : [entry('inner.md')]
  }))
})

describe('path helpers', () => {
  it('walks up and joins without doubling slashes', () => {
    expect(parentPath('/home/u/docs')).toBe('/home/u')
    expect(parentPath('/home')).toBe('/')
    expect(parentPath('/')).toBe('/')
    expect(joinPath('/', 'etc')).toBe('/etc')
    expect(joinPath('/home/u', 'a')).toBe('/home/u/a')
  })
})

describe('useSftpBrowser', () => {
  it('opens the login directory of the session', async () => {
    const { result } = renderHook(() => useSftpBrowser('s1'))
    await waitFor(() => expect(result.current.currentPath).toBe('/home/u'))
    expect(sshApi.sftpRealpath).toHaveBeenCalledWith('s1', '.')
    expect(result.current.entries.map((e) => e.name)).toEqual(['docs', 'a.txt'])
  })

  it('expands and collapses folders', async () => {
    const { result } = renderHook(() => useSftpBrowser('s1'))
    await waitFor(() => expect(result.current.currentPath).toBe('/home/u'))
    await act(() => result.current.toggleDirectory('/home/u/docs'))
    expect(result.current.expandedDirs.has('/home/u/docs')).toBe(true)
    expect(result.current.childEntries.get('/home/u/docs')?.[0].name).toBe('inner.md')
    await act(() => result.current.toggleDirectory('/home/u/docs'))
    expect(result.current.expandedDirs.has('/home/u/docs')).toBe(false)
  })

  it('reports errors so the view can offer a retry', async () => {
    sshApi.sftpRealpath.mockResolvedValue({ success: false, error: 'SFTP refused', code: 'X' })
    const { result } = renderHook(() => useSftpBrowser('s1'))
    await waitFor(() => expect(result.current.error).toBe('SFTP refused'))
    expect(result.current.isLoadingRoot).toBe(false)
  })

  it('drops replies for a previous session', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    sshApi.sftpRealpath.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve))
    )
    const { result, rerender } = renderHook(({ id }) => useSftpBrowser(id), {
      initialProps: { id: 's1' as string | null }
    })
    rerender({ id: 's2' })
    await waitFor(() => expect(result.current.currentPath).toBe('/home/u'))
    sshApi.sftpListDir.mockResolvedValue({ success: true, data: [entry('stale')] })
    await act(async () => resolveFirst({ success: true, data: '/root' }))
    expect(result.current.currentPath).toBe('/home/u')
    expect(result.current.entries.map((e) => e.name)).not.toContain('stale')
  })

  it('drops a directory listing that arrives after the session changed', async () => {
    let resolveStale: (value: unknown) => void = () => {}
    sshApi.sftpListDir.mockImplementation(async (id: string) =>
      id === 's1'
        ? new Promise((resolve) => (resolveStale = resolve))
        : { success: true, data: [entry('fresh')] }
    )
    const { result, rerender } = renderHook(({ id }) => useSftpBrowser(id), {
      initialProps: { id: 's1' as string | null }
    })
    await waitFor(() => expect(sshApi.sftpListDir).toHaveBeenCalledWith('s1', '/home/u'))
    rerender({ id: 's2' })
    await waitFor(() => expect(result.current.entries.map((e) => e.name)).toEqual(['fresh']))
    await act(async () => resolveStale({ success: true, data: [entry('stale')] }))
    expect(result.current.entries.map((e) => e.name)).toEqual(['fresh'])
  })

  it('never shows the previous session after switching', async () => {
    const shown: Array<[string | null, string | null, number]> = []
    const { result, rerender } = renderHook(
      ({ id }) => {
        const browser = useSftpBrowser(id)
        // Effects only run for committed renders, i.e. what the user can see.
        useEffect(() => {
          shown.push([id, browser.currentPath, browser.entries.length])
        })
        return browser
      },
      { initialProps: { id: 's1' as string | null } }
    )
    await waitFor(() => expect(result.current.currentPath).toBe('/home/u'))
    shown.length = 0
    rerender({ id: 's2' })
    expect(shown[0]).toEqual(['s2', null, 0])
  })

  it('keeps the latest directory when an earlier request answers last', async () => {
    const { result } = renderHook(() => useSftpBrowser('s1'))
    await waitFor(() => expect(result.current.currentPath).toBe('/home/u'))
    let resolveSlow: (value: unknown) => void = () => {}
    sshApi.sftpListDir.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSlow = resolve))
    )
    let slow: Promise<void> = Promise.resolve()
    act(() => {
      slow = result.current.loadDirectory('/slow')
    })
    await act(() => result.current.loadDirectory('/home/u/docs'))
    await act(async () => {
      resolveSlow({ success: true, data: [entry('old')] })
      await slow
    })
    expect(result.current.currentPath).toBe('/home/u/docs')
    expect(result.current.entries.map((e) => e.name)).toEqual(['inner.md'])
    expect(result.current.isLoadingRoot).toBe(false)
  })

  it('clears the error once a folder retry succeeds', async () => {
    const { result } = renderHook(() => useSftpBrowser('s1'))
    await waitFor(() => expect(result.current.currentPath).toBe('/home/u'))
    sshApi.sftpListDir.mockResolvedValueOnce({ success: false, error: 'Denied', code: 'X' })
    await act(() => result.current.toggleDirectory('/home/u/docs'))
    expect(result.current.error).toBe('Denied')
    await act(() => result.current.toggleDirectory('/home/u/docs'))
    expect(result.current.expandedDirs.has('/home/u/docs')).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('stays empty without a session', () => {
    const { result } = renderHook(() => useSftpBrowser(null))
    expect(result.current.currentPath).toBeNull()
    expect(sshApi.sftpRealpath).not.toHaveBeenCalled()
  })
})
