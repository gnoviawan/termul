import { act, renderHook, waitFor } from '@testing-library/react'
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

  it('stays empty without a session', () => {
    const { result } = renderHook(() => useSftpBrowser(null))
    expect(result.current.currentPath).toBeNull()
    expect(sshApi.sftpRealpath).not.toHaveBeenCalled()
  })
})
