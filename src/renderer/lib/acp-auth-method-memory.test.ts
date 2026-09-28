import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: vi.fn(),
    write: vi.fn()
  }
}))

import { persistenceApi } from '@/lib/api'
import {
  ACP_AUTH_METHODS_KEY,
  loadAuthMethodMemory,
  saveAuthMethodMemory
} from './acp-auth-method-memory'

describe('acp auth-method memory persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns {} when the key is missing (KEY_NOT_FOUND)', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      code: 'KEY_NOT_FOUND',
      error: 'key not found'
    })
    expect(await loadAuthMethodMemory()).toEqual({})
  })

  it('returns the stored configId → methodId map', async () => {
    const stored = { 'cfg-a': 'cursor_login', 'cfg-b': 'chatgpt' }
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: stored
    })
    expect(await loadAuthMethodMemory()).toEqual(stored)
    expect(persistenceApi.read).toHaveBeenCalledWith(ACP_AUTH_METHODS_KEY)
  })

  it('round-trips a saved map through write → load', async () => {
    const map = { 'cfg-1': 'api_key' }
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: map
    })
    await saveAuthMethodMemory(map)
    expect(persistenceApi.write).toHaveBeenCalledWith(ACP_AUTH_METHODS_KEY, map)
    expect(await loadAuthMethodMemory()).toEqual(map)
  })

  it('sanitizes corrupt entries on load (non-string values, blank keys/values)', async () => {
    // A corrupt persisted map must never crash startup or feed a non-string
    // method id into `authenticate` — drop malformed entries silently.
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        'cfg-ok': 'm1',
        '   ': 'blank-key',
        'cfg-num': 42,
        'cfg-null': null,
        'cfg-blank': '   ',
        'cfg-obj': { id: 'x' }
      }
    })
    expect(await loadAuthMethodMemory()).toEqual({ 'cfg-ok': 'm1' })
  })

  it('trims configId keys and method ids on load', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { '  cfg-1  ': '  cursor_login  ' }
    })
    expect(await loadAuthMethodMemory()).toEqual({ 'cfg-1': 'cursor_login' })
  })

  it.each([
    [null],
    ['a string'],
    [42],
    [['cfg-1']],
    [true]
  ])('returns {} for a non-map payload (%j)', async (data) => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data
    })
    expect(await loadAuthMethodMemory()).toEqual({})
  })

  it('throws on a real read failure (not collapsed to empty)', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      code: 'BACKEND_ERROR',
      error: 'store corrupted'
    })
    await expect(loadAuthMethodMemory()).rejects.toThrow(/store corrupted/)
  })

  it('writes under the dedicated key and throws on failure', async () => {
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
    await saveAuthMethodMemory({ 'cfg-1': 'm1' })
    expect(persistenceApi.write).toHaveBeenCalledWith(ACP_AUTH_METHODS_KEY, { 'cfg-1': 'm1' })
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'disk full'
    })
    await expect(saveAuthMethodMemory({})).rejects.toThrow(/disk full/)
  })
})
