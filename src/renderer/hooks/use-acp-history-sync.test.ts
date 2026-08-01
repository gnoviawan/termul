import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useAcpHistorySync } from './use-acp-history-sync'

describe('useAcpHistorySync', () => {
  it('is a compatibility no-op because shared-live reads durable Rust history', () => {
    const { result, unmount } = renderHook(() => useAcpHistorySync())

    expect(result.current).toBeUndefined()
    unmount()
  })
})
