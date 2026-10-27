import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockListCatalog } = vi.hoisted(() => ({ mockListCatalog: vi.fn() }))

vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return { ...actual, acpCatalogApi: { ...actual.acpCatalogApi, listCatalog: mockListCatalog } }
})
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => false,
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { useResolvedSupportedAcpAgentsState } from '@/hooks/use-resolved-supported-acp-agents'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'

const CATALOG = {
  success: true,
  data: {
    host: { os: 'linux', arch: 'x86_64', runtimes: { npx: true } },
    agents: [
      {
        id: 'factory-droid',
        name: 'Factory Droid',
        version: '0.219.0',
        description: 'Factory Droid',
        source: 'bundled',
        distribution: { npx: { package: 'droid@0.219.0', args: [] } },
        runtimeRequirements: ['npx'],
        status: 'ready',
        platformTargets: [],
        installed: null
      }
    ]
  }
} as const
const FAILURE = { success: false, error: 'catalog unavailable' } as const
const CUSTOM: StoredAgentConfig = {
  id: 'my-agent',
  name: 'My Agent',
  command: 'my-agent',
  args: [],
  env: {},
  allowTerminal: false
}
const NO_CONFIGS: readonly StoredAgentConfig[] = []
const CUSTOM_ONLY: readonly StoredAgentConfig[] = [CUSTOM]

function names(result: { current: { entries: readonly { agent: { name: string } }[] } }) {
  return result.current.entries.map((e) => e.agent.name)
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('useResolvedSupportedAcpAgentsState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockListCatalog.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports loading until the first catalog resolves, then the catalog agents', async () => {
    let resolveCatalog: (value: typeof CATALOG) => void = () => {}
    mockListCatalog.mockReturnValue(new Promise((r) => (resolveCatalog = r)))

    const { result } = renderHook(() => useResolvedSupportedAcpAgentsState(NO_CONFIGS))
    await flush()
    expect(result.current.status).toBe('loading')
    expect(names(result)).toEqual([])

    await act(async () => resolveCatalog(CATALOG))
    expect(result.current.status).toBe('ready')
    expect(names(result)).toEqual(['Factory Droid'])
  })

  it('retries a failed catalog fetch with backoff and keeps custom agents meanwhile', async () => {
    mockListCatalog.mockResolvedValueOnce(FAILURE).mockResolvedValueOnce(CATALOG)

    const { result } = renderHook(() => useResolvedSupportedAcpAgentsState(CUSTOM_ONLY))
    await flush()
    expect(result.current.status).toBe('loading')
    expect(names(result)).toEqual(['My Agent'])
    expect(mockListCatalog).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(mockListCatalog).toHaveBeenCalledTimes(2)
    expect(result.current.status).toBe('ready')
    expect(names(result)).toEqual(['Factory Droid', 'My Agent'])
  })

  it('gives up after the bounded retries and recovers through retry()', async () => {
    mockListCatalog.mockResolvedValue(FAILURE)

    const { result } = renderHook(() => useResolvedSupportedAcpAgentsState(NO_CONFIGS))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mockListCatalog).toHaveBeenCalledTimes(6)
    expect(result.current.status).toBe('unavailable')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mockListCatalog).toHaveBeenCalledTimes(6)

    mockListCatalog.mockResolvedValue(CATALOG)
    act(() => result.current.retry())
    await flush()
    expect(result.current.status).toBe('ready')
    expect(names(result)).toEqual(['Factory Droid'])
  })

  it('retries an exhausted catalog when the window regains focus', async () => {
    mockListCatalog.mockResolvedValue(FAILURE)
    const { result } = renderHook(() => useResolvedSupportedAcpAgentsState(NO_CONFIGS))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(result.current.status).toBe('unavailable')

    mockListCatalog.mockResolvedValue(CATALOG)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    expect(result.current.status).toBe('ready')
    expect(names(result)).toEqual(['Factory Droid'])
  })

  it('treats a rejected resolution like a failed fetch', async () => {
    mockListCatalog.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValueOnce(CATALOG)

    const { result } = renderHook(() => useResolvedSupportedAcpAgentsState(NO_CONFIGS))
    await flush()
    expect(result.current.status).toBe('loading')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(result.current.status).toBe('ready')
    expect(names(result)).toEqual(['Factory Droid'])
  })
})
