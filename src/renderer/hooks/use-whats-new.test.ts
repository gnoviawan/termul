import { renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tauri-release-notes', () => ({
  compareVersions: vi.fn(),
  fetchReleaseNotes: vi.fn(),
  getCurrentAppVersion: vi.fn(),
  getLastSeenVersion: vi.fn(),
  setLastSeenVersion: vi.fn()
}))

import {
  compareVersions,
  fetchReleaseNotes,
  getCurrentAppVersion,
  getLastSeenVersion,
  setLastSeenVersion
} from '@/lib/tauri-release-notes'
import { useWhatsNew } from './use-whats-new'

const mockedCompare = vi.mocked(compareVersions)
const mockedFetch = vi.mocked(fetchReleaseNotes)
const mockedGetCurrent = vi.mocked(getCurrentAppVersion)
const mockedGetLastSeen = vi.mocked(getLastSeenVersion)
const mockedSetLastSeen = vi.mocked(setLastSeenVersion)

describe('useWhatsNew', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedSetLastSeen.mockResolvedValue(undefined)
    // Default numeric comparison so tests that don't override behave sensibly.
    mockedCompare.mockImplementation((a, b) => (a === b ? 0 : a > b ? 1 : -1))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records current version and shows nothing on fresh install', async () => {
    mockedGetCurrent.mockResolvedValue('0.4.7')
    mockedGetLastSeen.mockResolvedValue(null)

    const { result } = renderHook(() => useWhatsNew())

    await waitFor(() => {
      expect(mockedSetLastSeen).toHaveBeenCalledWith('0.4.7')
    })
    expect(result.current.isOpen).toBe(false)
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('shows the popup with notes after an update', async () => {
    mockedGetCurrent.mockResolvedValue('0.4.7')
    mockedGetLastSeen.mockResolvedValue('0.4.6')
    mockedCompare.mockReturnValue(1)
    mockedFetch.mockResolvedValue({
      version: '0.4.7',
      notes: '- New stuff',
      htmlUrl: 'https://example.com'
    })

    const { result } = renderHook(() => useWhatsNew())

    await waitFor(() => {
      expect(result.current.isOpen).toBe(true)
    })
    expect(result.current.version).toBe('0.4.7')
    expect(result.current.notes).toBe('- New stuff')
    expect(result.current.htmlUrl).toBe('https://example.com')
    expect(mockedSetLastSeen).toHaveBeenCalledWith('0.4.7')
  })

  it('does not show the popup when the version is unchanged', async () => {
    mockedGetCurrent.mockResolvedValue('0.4.7')
    mockedGetLastSeen.mockResolvedValue('0.4.7')
    mockedCompare.mockReturnValue(0)

    const { result } = renderHook(() => useWhatsNew())

    await waitFor(() => {
      expect(mockedGetLastSeen).toHaveBeenCalled()
    })
    expect(result.current.isOpen).toBe(false)
    expect(mockedFetch).not.toHaveBeenCalled()
    expect(mockedSetLastSeen).not.toHaveBeenCalled()
  })

  it('does not show the popup on a downgrade', async () => {
    mockedGetCurrent.mockResolvedValue('0.4.6')
    mockedGetLastSeen.mockResolvedValue('0.4.7')
    mockedCompare.mockReturnValue(-1)

    const { result } = renderHook(() => useWhatsNew())

    await waitFor(() => {
      expect(mockedGetLastSeen).toHaveBeenCalled()
    })
    expect(result.current.isOpen).toBe(false)
    expect(mockedFetch).not.toHaveBeenCalled()
    expect(mockedSetLastSeen).not.toHaveBeenCalled()
  })

  it('marks the version seen even when the fetch fails, without opening', async () => {
    mockedGetCurrent.mockResolvedValue('0.4.7')
    mockedGetLastSeen.mockResolvedValue('0.4.6')
    mockedCompare.mockReturnValue(1)
    mockedFetch.mockResolvedValue(null)

    const { result } = renderHook(() => useWhatsNew())

    await waitFor(() => {
      expect(mockedSetLastSeen).toHaveBeenCalledWith('0.4.7')
    })
    expect(result.current.isOpen).toBe(false)
  })

  it('closes when close() is called', async () => {
    mockedGetCurrent.mockResolvedValue('0.4.7')
    mockedGetLastSeen.mockResolvedValue('0.4.6')
    mockedCompare.mockReturnValue(1)
    mockedFetch.mockResolvedValue({ version: '0.4.7', notes: '- New', htmlUrl: null })

    const { result } = renderHook(() => useWhatsNew())

    await waitFor(() => {
      expect(result.current.isOpen).toBe(true)
    })

    act(() => {
      result.current.close()
    })

    expect(result.current.isOpen).toBe(false)
  })
})
