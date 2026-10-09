import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { usePermissionDenialNotice } from './use-permission-denial-notice'

const DENIED =
  'Permission for npm test -- auth was denied because this device disconnected. Ask the agent to retry.'

function setNotices(notices: Record<string, { requestId: string; tool: string }>): void {
  act(() => {
    useAcpStore.setState({ permissionDenialNotices: notices })
  })
}

describe('usePermissionDenialNotice', () => {
  beforeEach(() => {
    useAcpStore.setState(FRESH)
  })

  it('has no line without a notice', () => {
    const { result } = renderHook(() => usePermissionDenialNotice('s1'))
    expect(result.current.message).toBeNull()
  })

  it('reads the notice of its own session through the shared copy', () => {
    setNotices({ s1: { requestId: 'r1', tool: 'npm test -- auth' } })
    const { result } = renderHook(() => usePermissionDenialNotice('s1'))
    expect(result.current.message).toBe(DENIED)

    const other = renderHook(() => usePermissionDenialNotice('s2'))
    expect(other.result.current.message).toBeNull()
  })

  it('follows the store when the notice arrives and clears', () => {
    const { result } = renderHook(() => usePermissionDenialNotice('s1'))
    setNotices({ s1: { requestId: 'r1', tool: 'npm test -- auth' } })
    expect(result.current.message).toBe(DENIED)

    setNotices({})
    expect(result.current.message).toBeNull()
  })

  it('hides only the dismissed notice, in local state and not in the store', () => {
    const notices = { s1: { requestId: 'r1', tool: 'npm test -- auth' } }
    setNotices(notices)
    const { result } = renderHook(() => usePermissionDenialNotice('s1'))

    act(() => result.current.dismiss())
    expect(result.current.message).toBeNull()
    expect(useAcpStore.getState().permissionDenialNotices).toBe(notices)

    setNotices({ s1: { requestId: 'r2', tool: 'git push' } })
    expect(result.current.message).toBe(
      'Permission for git push was denied because this device disconnected. Ask the agent to retry.'
    )
  })

  it('ignores a dismiss with nothing to dismiss', () => {
    const { result } = renderHook(() => usePermissionDenialNotice('s1'))
    act(() => result.current.dismiss())
    setNotices({ s1: { requestId: 'r1', tool: 'npm test -- auth' } })
    expect(result.current.message).toBe(DENIED)
  })
})
