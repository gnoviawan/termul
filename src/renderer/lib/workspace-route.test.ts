import { describe, expect, it } from 'vitest'
import { isWorkspaceRoutePath } from './workspace-route'

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
