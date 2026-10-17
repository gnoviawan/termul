/**
 * Issue #1363: a blackholed `/fs/write` (TCP open, no reply) must not strand
 * the save forever. The web fs adapter bounds the request; the save then
 * settles as a failure and the per-file save lock releases, so a rename
 * waiting on it (since #1357) proceeds.
 *
 * The store runs against the REAL web adapter. Only the wire (`fetch`) is
 * mocked, so the bound, the ledgered resend ladder, and the uncertain-write
 * verify read all execute.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }))

vi.mock('@/lib/api', async () => {
  const { webServerFilesystem } = await import('@/lib/web-server-api')
  return {
    filesystemApi: {
      writeFile: webServerFilesystem.writeFile,
      readFile: webServerFilesystem.readFile,
      renameFile: webServerFilesystem.renameFile
    }
  }
})

const { mockLogFrontendError } = vi.hoisted(() => ({ mockLogFrontendError: vi.fn() }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLogFrontendError }))

vi.mock('@/lib/schedule-git-status-refresh', () => ({
  scheduleGitStatusRefreshForPath: vi.fn()
}))

import { filesystemApi } from '@/lib/api'
import { cancelAllAutoSaves } from '@/lib/editor-auto-save'
import { renameBetweenSaves, useEditorStore } from './editor-store'

const path = '/project/a.ts'
const renamed = '/project/b.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body)
  } as unknown as Response
}

/** A web-opened dirty file: the host reported a content hash on read. */
function seedDirtyWebFile(): void {
  useEditorStore.setState({
    openFiles: new Map([
      [
        path,
        {
          filePath: path,
          content: 'edited',
          originalContent: 'on disk',
          isDirty: true,
          language: 'typescript',
          lastModified: 0,
          contentHash: 'abc123',
          tracksHash: true as const,
          viewMode: 'code',
          cursorPosition: { line: 1, col: 1 },
          scrollTop: 0,
          operationStatus: 'idle'
        }
      ]
    ]),
    activeFilePath: path
  })
}

describe('editor save with a blackholed web write (#1363)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
    seedDirtyWebFile()
  })

  afterEach(() => {
    cancelAllAutoSaves()
    useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
    vi.unstubAllGlobals()
  })

  it('the save settles false after the bound and a pending rename proceeds', async () => {
    vi.useFakeTimers()
    try {
      mockFetch.mockImplementation((input: unknown, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/fs/rename')) {
          return Promise.resolve(jsonResponse({ success: true }))
        }
        // Settles only via the caller's abort signal, like a real fetch
        // against a blackholed server that never replies.
        const signal = init?.signal
        return new Promise<Response>((_resolve, reject) => {
          const fail = () =>
            reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
          if (signal?.aborted) return fail()
          signal?.addEventListener('abort', fail)
        })
      })

      const save = useEditorStore.getState().saveFile(path)
      const rename = renameBetweenSaves(path, renamed, () =>
        filesystemApi.renameFile(path, renamed)
      )

      // Write bound (30s) + ledgered resend ladder (1+2+4s), then the
      // uncertain-write verify-read bound (30s).
      await vi.advanceTimersByTimeAsync(30_000 + 7_000 + 30_000 + 1_000)

      await expect(save).resolves.toBe(false)
      await expect(rename).resolves.toEqual({ success: true, data: undefined })
      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}/fs/rename`,
        expect.objectContaining({ method: 'POST' })
      )
      // The timeout is boundary-logged (warn) and the failed save boundary-logged.
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', source: 'webServerFilesystem.writeFile' })
      )
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          source: 'editor-store.saveFile',
          message: expect.stringContaining('editor save failed')
        })
      )
      // The buffer stays dirty; the write outcome was never confirmed.
      expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
