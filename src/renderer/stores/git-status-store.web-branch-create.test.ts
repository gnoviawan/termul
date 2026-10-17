import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }))

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => false }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: vi.fn() }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { __resetCommandEngineForTesting } from '@/lib/command-engine'
import { __clearCommandJournalForTesting } from '@/lib/command-journal'
import { useGitStatusStore } from './git-status-store'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body)
  } as unknown as Response
}

describe('git status store branchCreate in web mode', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: null }))
    vi.stubGlobal('fetch', mockFetch)
    __clearCommandJournalForTesting()
    __resetCommandEngineForTesting()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates the branch through the ledgered route with a command id', async () => {
    await useGitStatusStore.getState().branchCreate('/web/proj', 'feature/new')

    const [url, init] = mockFetch.mock.calls[0]
    expect(init.headers).toEqual(
      expect.objectContaining({ 'X-Command-Id': expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/) })
    )
    expect(url).toBe(`${window.location.origin}/git/create-branch`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ cwd: '/web/proj', branch: 'feature/new' })
  })
})
