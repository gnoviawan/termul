import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockProject } from '@/lib/test-utils/store'
import { useProjectStore } from '@/stores/project-store'
import { useProjectIcon } from './use-project-icon'

const { mockGetProjectIcon, mockLogFrontendError } = vi.hoisted(() => ({
  mockGetProjectIcon: vi.fn(),
  mockLogFrontendError: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  gitApi: { getProjectIcon: mockGetProjectIcon }
}))
vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

const ICON = {
  dataUri: 'data:image/png;base64,QUJD',
  mime: 'image/png',
  source: 'file' as const
}

function seed(projects: ReturnType<typeof mockProject>[]): void {
  useProjectStore.setState({
    projects,
    groups: [],
    activeProjectId: projects[0]?.id ?? '',
    isLoaded: true
  })
}

/** A promise the test resolves by hand — models an in-flight backend resolve. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useProjectIcon', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed([])
  })

  it('resolves every project that has a path and stamps fetchedAt', async () => {
    mockGetProjectIcon.mockResolvedValue(ICON)
    seed([
      mockProject({ id: 'a', path: '/repo/a' }),
      mockProject({ id: 'b', path: '/repo/b' }),
      mockProject({ id: 'c', path: undefined }) // no path → skipped
    ])
    renderHook(() => useProjectIcon())

    await waitFor(() => {
      const [a, b, c] = useProjectStore.getState().projects
      expect(a.icon?.dataUri).toBe(ICON.dataUri)
      expect(b.icon?.dataUri).toBe(ICON.dataUri)
      expect(c.icon).toBeUndefined()
    })
    expect(mockGetProjectIcon).toHaveBeenCalledTimes(2)
    expect(mockGetProjectIcon).toHaveBeenCalledWith('/repo/a')
    expect(mockGetProjectIcon).toHaveBeenCalledWith('/repo/b')
    const stamped = useProjectStore.getState().projects[0].icon?.fetchedAt
    expect(typeof stamped).toBe('number')
  })

  it('skips re-resolving a freshly fetched icon (<24 h)', async () => {
    const fresh = { ...ICON, fetchedAt: Date.now() - 60_000 }
    seed([mockProject({ id: 'a', path: '/repo/a', icon: fresh })])
    renderHook(() => useProjectIcon())
    // Give the effect a beat — nothing should be requested.
    await Promise.resolve()
    expect(mockGetProjectIcon).not.toHaveBeenCalled()
    expect(useProjectStore.getState().projects[0].icon).toEqual(fresh)
  })

  it('re-resolves a stale icon (>24 h)', async () => {
    const stale = { ...ICON, fetchedAt: Date.now() - 25 * 60 * 60 * 1000 }
    mockGetProjectIcon.mockResolvedValue({ ...ICON, source: 'remote' as const })
    seed([mockProject({ id: 'a', path: '/repo/a', icon: stale })])
    renderHook(() => useProjectIcon())

    await waitFor(() => {
      expect(useProjectStore.getState().projects[0].icon?.source).toBe('remote')
    })
    expect(mockGetProjectIcon).toHaveBeenCalledWith('/repo/a')
  })

  it('clears the stored icon when the resolver reports null (monogram)', async () => {
    mockGetProjectIcon.mockResolvedValue(null)
    seed([mockProject({ id: 'a', path: '/repo/a', icon: ICON })])
    renderHook(() => useProjectIcon())

    await waitFor(() => {
      expect(useProjectStore.getState().projects[0].icon).toBeUndefined()
    })
  })

  it('retains the existing icon and logs when the transport throws', async () => {
    mockGetProjectIcon.mockRejectedValue(new Error('NETWORK_ERROR'))
    seed([mockProject({ id: 'a', path: '/repo/a', icon: ICON })])
    renderHook(() => useProjectIcon())

    await waitFor(() => {
      expect(mockLogFrontendError).toHaveBeenCalled()
    })
    // A thrown error retains whatever icon is stored — it keeps rendering.
    expect(useProjectStore.getState().projects[0].icon).toEqual(ICON)
    expect(mockLogFrontendError.mock.calls[0][0].source).toBe('useProjectIcon')
  })

  it('discards a stale in-flight result when the project is re-resolved', async () => {
    // First resolve hangs; a path change triggers a second resolve — the
    // earlier completion must NOT overwrite the newer result.
    const first = deferred<typeof ICON | null>()
    const second = deferred<typeof ICON | null>()
    mockGetProjectIcon.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const project = mockProject({ id: 'a', path: '/repo/a' })
    seed([project])
    renderHook(() => useProjectIcon())
    expect(mockGetProjectIcon).toHaveBeenCalledWith('/repo/a')

    // Path change re-triggers resolution (attempt clock keyed on path).
    useProjectStore.setState((s) => ({
      projects: [{ ...s.projects[0], path: '/repo/a2' }]
    }))
    await waitFor(() => expect(mockGetProjectIcon).toHaveBeenCalledWith('/repo/a2'))

    // Newer request wins; the stale first request is then discarded.
    second.resolve(ICON)
    await waitFor(() => {
      expect(useProjectStore.getState().projects[0].icon?.dataUri).toBe(ICON.dataUri)
    })
    first.resolve(null)
    await Promise.resolve()
    expect(useProjectStore.getState().projects[0].icon?.dataUri).toBe(ICON.dataUri)
  })

  it('keeps a slow resolve when another project resolves first', async () => {
    // Regression: a landed icon mutates `projects`, which re-runs the effect.
    // A cleanup-style cancel flag would drop every slower still-in-flight
    // resolve — and the attempt clock would suppress the retry — leaving
    // remote (slower) icons permanently unresolved.
    const slow = deferred<typeof ICON | null>()
    mockGetProjectIcon
      .mockResolvedValueOnce(ICON) // a lands fast (local-file speed)
      .mockReturnValueOnce(slow.promise) // b is still in flight
    seed([mockProject({ id: 'a', path: '/repo/a' }), mockProject({ id: 'b', path: '/repo/b' })])
    renderHook(() => useProjectIcon())

    await waitFor(() => {
      expect(useProjectStore.getState().projects[0].icon?.dataUri).toBe(ICON.dataUri)
    })

    slow.resolve({ ...ICON, source: 'remote' as const })
    await waitFor(() => {
      expect(useProjectStore.getState().projects[1].icon?.source).toBe('remote')
    })
  })

  it('does not re-resolve in a loop after a null result', async () => {
    mockGetProjectIcon.mockResolvedValue(null)
    seed([mockProject({ id: 'a', path: '/repo/a' })])
    renderHook(() => useProjectIcon())

    await waitFor(() => expect(mockGetProjectIcon).toHaveBeenCalledTimes(1))
    // An unrelated store change re-runs the effect; the in-memory attempt
    // clock must suppress a second backend call for the same path.
    useProjectStore.setState((s) => ({
      projects: [{ ...s.projects[0], name: 'renamed' }]
    }))
    await Promise.resolve()
    expect(mockGetProjectIcon).toHaveBeenCalledTimes(1)
  })
})
