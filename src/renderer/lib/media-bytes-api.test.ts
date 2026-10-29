import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriContext: vi.fn(() => false),
  logFrontendError: vi.fn(() => Promise.resolve())
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('./tauri-runtime', () => ({ isTauriContext: () => mocks.isTauriContext() }))
vi.mock('./log-api', () => ({ logFrontendError: mocks.logFrontendError }))
vi.mock('./web-auth-token', () => ({ authHeader: () => ({ Authorization: 'Bearer t0ken' }) }))

import { readMediaBytes } from './media-bytes-api'

/** jsdom's Blob lacks `arrayBuffer()`; a fetch Response's Blob is Node's and has it. */
function blobText(blob: Blob): Promise<string> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buffer) => new TextDecoder().decode(buffer))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

describe('readMediaBytes on desktop', () => {
  beforeEach(() => {
    mocks.isTauriContext.mockReturnValue(true)
    mocks.invoke.mockReset()
    mocks.logFrontendError.mockClear()
  })

  it('wraps the command bytes in a Blob typed by the extension', async () => {
    mocks.invoke.mockResolvedValueOnce(new Uint8Array([65, 66, 67]).buffer)

    const result = await readMediaBytes('/proj/out/clip.webm')

    expect(mocks.invoke).toHaveBeenCalledWith('read_media_bytes', { path: '/proj/out/clip.webm' })
    if (!result.success) throw new Error(result.error)
    expect(result.data.type).toBe('video/webm')
    expect(await blobText(result.data)).toBe('ABC')
    expect(mocks.logFrontendError).not.toHaveBeenCalled()
  })

  it('maps the rejected error object to its code and logs the basename', async () => {
    mocks.invoke.mockRejectedValueOnce({ code: 'FILE_TOO_LARGE', message: 'file too large' })

    const result = await readMediaBytes('/home/u/secret-dir/huge.png')

    expect(result).toEqual({ success: false, error: 'file too large', code: 'FILE_TOO_LARGE' })
    expect(mocks.logFrontendError).toHaveBeenCalledWith({
      level: 'warn',
      source: 'mediaBytes.read',
      message: "Failed to read media 'huge.png' (FILE_TOO_LARGE)"
    })
  })

  it('maps an IPC fault without a code to INVOKE_ERROR', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('command read_media_bytes not found'))

    expect(await readMediaBytes('/a.png')).toEqual({
      success: false,
      error: 'command read_media_bytes not found',
      code: 'INVOKE_ERROR'
    })
  })
})

describe('readMediaBytes on web', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    mocks.isTauriContext.mockReturnValue(false)
    mocks.logFrontendError.mockClear()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('fetches /fs/raw with the bearer header and returns the body blob', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([80, 78, 71]), { headers: { 'content-type': 'image/png' } })
    )

    const result = await readMediaBytes('/proj/my chart.png')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${window.location.origin}/fs/raw?path=%2Fproj%2Fmy%20chart.png`)
    expect(init.headers).toEqual({ Authorization: 'Bearer t0ken' })
    if (!result.success) throw new Error(result.error)
    expect(result.data.type).toBe('image/png')
    expect(await blobText(result.data)).toBe('PNG')
  })

  it('keeps the server code from a non-2xx failure body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: 'not a supported image',
          code: 'UNSUPPORTED_MEDIA'
        }),
        { status: 415, headers: { 'content-type': 'application/json' } }
      )
    )

    expect(await readMediaBytes('/proj/notes.txt')).toEqual({
      success: false,
      error: 'not a supported image',
      code: 'UNSUPPORTED_MEDIA'
    })
    expect(mocks.logFrontendError).toHaveBeenCalledWith({
      level: 'warn',
      source: 'mediaBytes.read',
      message: "Failed to read media 'notes.txt' (UNSUPPORTED_MEDIA)"
    })
  })

  it('maps a thrown fetch to NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    expect(await readMediaBytes('/proj/a.png')).toEqual({
      success: false,
      error: 'Failed to fetch',
      code: 'NETWORK_ERROR'
    })
  })

  it('aborts a request the server never answers after 30s', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })
    )

    const pending = readMediaBytes('/proj/clip.mp4')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(await pending).toEqual({
      success: false,
      error: 'readMediaBytes timed out',
      code: 'NETWORK_ERROR'
    })
  })
})
