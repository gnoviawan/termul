import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store, api, mockLog } = vi.hoisted(() => {
  const store = new Map<string, unknown>()
  return {
    store,
    mockLog: vi.fn(async () => {}),
    api: {
      writeFails: false,
      read: vi.fn(async (key: string) =>
        store.has(key)
          ? { success: true, data: store.get(key) }
          : { success: false, code: 'KEY_NOT_FOUND', error: `Key not found: ${key}` }
      ),
      writeDebounced: vi.fn(async (key: string, data: unknown) => {
        if (api.writeFails) return { success: false, code: 'WRITE_ERROR', error: 'disk full' }
        store.set(key, data)
        return { success: true, data: undefined }
      })
    }
  }
})

vi.mock('@/lib/api', () => ({ persistenceApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLog }))

import { modelCatalogFromOptions, persistModelCatalog, readModelCatalog } from './model-catalog'

const MODEL_OPTION = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'opus',
  options: [{ value: 'opus', name: 'Opus' }]
}

describe('model catalog persistence', () => {
  beforeEach(() => {
    store.clear()
    api.writeFails = false
    vi.clearAllMocks()
  })

  it('keeps only the model list from an options-cache entry', () => {
    const catalog = modelCatalogFromOptions({
      models: null,
      configOptions: [MODEL_OPTION, { ...MODEL_OPTION, id: 'effort', category: 'thought_level' }]
    })
    expect(catalog?.modelOption?.id).toBe('model')
    expect(catalog?.models).toBeNull()
  })

  it('returns null when the entry has no model list', () => {
    expect(modelCatalogFromOptions({ models: null, configOptions: [] })).toBeNull()
  })

  it('round-trips a saved list per config', async () => {
    const catalog = modelCatalogFromOptions({ models: null, configOptions: [MODEL_OPTION] })
    if (!catalog) throw new Error('expected a catalog')
    persistModelCatalog('acp-registry:cursor', catalog)
    await vi.waitFor(() => expect(store.size).toBe(1))
    expect(api.writeDebounced).toHaveBeenCalledWith(
      'agents/model-catalog/acp-registry:cursor',
      catalog
    )
    expect(await readModelCatalog('acp-registry:cursor')).toEqual(catalog)
  })

  it('reads null without a log when nothing is saved', async () => {
    expect(await readModelCatalog('unknown')).toBeNull()
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('logs a failed write and never throws', async () => {
    api.writeFails = true
    const catalog = modelCatalogFromOptions({ models: null, configOptions: [MODEL_OPTION] })
    if (!catalog) throw new Error('expected a catalog')
    expect(() => persistModelCatalog('c', catalog)).not.toThrow()
    await vi.waitFor(() => expect(mockLog).toHaveBeenCalled())
    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'acp-store.persistModelCatalog' })
    )
  })
})
