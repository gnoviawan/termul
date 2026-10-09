import { describe, expect, it, vi } from 'vitest'
import { isWorkspaceRoutePath, returnToWorkspaceRoute } from './workspace-route'

describe('isWorkspaceRoutePath', () => {
  it.each(['/', '/c/s1', '/c/'])('treats %s as a workspace route', (pathname) => {
    expect(isWorkspaceRoutePath(pathname)).toBe(true)
  })

  it.each([
    '/snapshots',
    '/settings',
    '/chat',
    '/cx/s1',
    ''
  ])('treats %s as a non-workspace route', (pathname) => {
    expect(isWorkspaceRoutePath(pathname)).toBe(false)
  })
})

describe('returnToWorkspaceRoute', () => {
  it.each([
    '/snapshots',
    '/settings',
    '/cx/s1',
    ''
  ])('navigates to / from %s and reports it', (pathname) => {
    const navigate = vi.fn()
    expect(returnToWorkspaceRoute(pathname, navigate)).toBe(true)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/')
  })

  it.each(['/', '/c/s1', '/c/'])('does not navigate on the workspace route %s', (pathname) => {
    const navigate = vi.fn()
    expect(returnToWorkspaceRoute(pathname, navigate)).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })
})
