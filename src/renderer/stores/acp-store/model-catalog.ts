import { type PersistedModelCatalog, PersistenceKeys } from '@shared/types/persistence.types'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import type { AgentOptionsCacheEntry } from './types'

const MODEL_CATEGORY = 'model'

/**
 * The model list part of an options-cache entry, or null when the entry has
 * no model list (nothing worth saving).
 */
export function modelCatalogFromOptions(
  entry: Pick<AgentOptionsCacheEntry, 'models' | 'configOptions'>
): PersistedModelCatalog | null {
  const option = entry.configOptions.find(
    (o) =>
      o.category === MODEL_CATEGORY &&
      typeof o.currentValue === 'string' &&
      (o.options?.length ?? 0) > 0
  )
  const models =
    entry.models && entry.models.availableModels.length > 0
      ? {
          currentModelId: entry.models.currentModelId,
          availableModels: entry.models.availableModels.map((m) => ({
            modelId: m.modelId,
            name: m.name,
            description: m.description ?? null
          }))
        }
      : null
  // Re-checking `typeof` narrows `currentValue` for the persisted shape,
  // which only allows a string.
  const modelOption =
    option && typeof option.currentValue === 'string'
      ? {
          id: option.id,
          name: option.name,
          currentValue: option.currentValue,
          options: (option.options ?? []).flatMap((o) =>
            typeof o.value === 'string'
              ? [{ value: o.value, name: o.name, description: o.description ?? null }]
              : []
          )
        }
      : null
  if (!modelOption && !models) return null
  return {
    models,
    modelOption,
    updatedAt: Date.now()
  }
}

/** Save the model list for a config. Fire-and-forget; failures are logged. */
export function persistModelCatalog(configId: string, catalog: PersistedModelCatalog): void {
  const fail = (reason: string): void => {
    void logFrontendError({
      level: 'warn',
      source: 'acp-store.persistModelCatalog',
      message: `persist failed for ${configId}: ${reason}`
    })
  }
  // The options cache is written from store setters; a storage failure here
  // must never break those setters, so this never throws.
  void (async () => {
    try {
      const result = await persistenceApi.writeDebounced(
        PersistenceKeys.agentModelCatalog(configId),
        catalog
      )
      if (!result.success) fail(result.error)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })()
}

/** Read the saved model list for a config. Null when none is saved or the read fails. */
export async function readModelCatalog(configId: string): Promise<PersistedModelCatalog | null> {
  try {
    const result = await persistenceApi.read<PersistedModelCatalog>(
      PersistenceKeys.agentModelCatalog(configId)
    )
    if (result.success) return result.data ?? null
    if (result.code !== 'KEY_NOT_FOUND') {
      void logFrontendError({
        level: 'warn',
        source: 'acp-store.readModelCatalog',
        message: `read failed for ${configId}: ${result.error}`
      })
    }
    return null
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: 'acp-store.readModelCatalog',
      message: `read failed for ${configId}: ${err instanceof Error ? err.message : String(err)}`
    })
    return null
  }
}
