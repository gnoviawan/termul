import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: vi.fn()
  }
}))

import { Store } from '@tauri-apps/plugin-store'
import {
  getSkippedVersion,
  skipVersion,
  clearSkippedVersion,
  isVersionSkipped,
  _resetVersionSkipStoreForTesting
} from '../tauri-version-skip'

const mockStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  save: vi.fn()
}

describe('tauri-version-skip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetVersionSkipStoreForTesting()

    vi.mocked(Store.load).mockResolvedValue(mockStore as never)

    mockStore.get.mockResolvedValue(null)
    mockStore.set.mockResolvedValue(undefined)
    mockStore.delete.mockResolvedValue(undefined)
    mockStore.save.mockResolvedValue(undefined)
  })

  it('getSkippedVersion returns null when no version is stored', async () => {
    const result = await getSkippedVersion()

    expect(result).toBeNull()
    expect(mockStore.get).toHaveBeenCalledWith('updater.skippedVersion')
  })

  it('skipVersion stores version and saves store', async () => {
    await skipVersion('2.0.0')

    expect(mockStore.set).toHaveBeenCalledWith('updater.skippedVersion', '2.0.0')
    expect(mockStore.save).toHaveBeenCalledTimes(1)
  })

  it('clearSkippedVersion deletes key and saves store', async () => {
    await clearSkippedVersion()

    expect(mockStore.delete).toHaveBeenCalledWith('updater.skippedVersion')
    expect(mockStore.save).toHaveBeenCalledTimes(1)
  })

  it('isVersionSkipped returns true only when stored version matches', async () => {
    mockStore.get.mockResolvedValue('2.1.0')

    await expect(isVersionSkipped('2.1.0')).resolves.toBe(true)
    await expect(isVersionSkipped('2.2.0')).resolves.toBe(false)
  })

  it('reuses loaded store instance between calls', async () => {
    await getSkippedVersion()
    await getSkippedVersion()

    expect(Store.load).toHaveBeenCalledTimes(1)
  })
})
