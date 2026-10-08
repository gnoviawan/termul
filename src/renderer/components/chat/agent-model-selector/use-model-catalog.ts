import type { PersistedModelCatalog } from '@shared/types/persistence.types'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { prepareChatKey } from '@/stores/acp-store/helpers'
import { readModelCatalog } from '@/stores/acp-store/model-catalog'
import { catalogFromPersisted, catalogFromSessionState, type ModelCatalog } from './selector-model'

/**
 * Saved model lists, read on demand. `undefined` = not read yet; `null` = read,
 * nothing saved.
 */
const usePersistedCatalogs = create<{ byConfig: Record<string, PersistedModelCatalog | null> }>(
  () => ({ byConfig: {} })
)
const reading = new Set<string>()

/** Read a config's saved model list once per app run. */
export function loadPersistedCatalog(configId: string): void {
  if (configId in usePersistedCatalogs.getState().byConfig || reading.has(configId)) return
  reading.add(configId)
  void readModelCatalog(configId)
    .then((catalog) => {
      usePersistedCatalogs.setState((s) => ({ byConfig: { ...s.byConfig, [configId]: catalog } }))
    })
    .finally(() => reading.delete(configId))
}

/** Test seam: forget the saved lists read so far. */
export function resetPersistedCatalogsForTests(): void {
  usePersistedCatalogs.setState({ byConfig: {} })
  reading.clear()
}

/**
 * In-memory model state for configs other than the chat's own agent: the
 * prepared (warm) session for this cwd first, then the options cache. Returns
 * a flat tuple per config so `useShallow` keeps the result stable.
 */
function useMemoryState(
  cwd: string,
  configIds: readonly string[]
): Array<{
  models: Parameters<typeof catalogFromSessionState>[0]
  configOptions: Parameters<typeof catalogFromSessionState>[1]
}> {
  const flat = useAcpStore(
    useShallow((s) => {
      const out: unknown[] = []
      for (const configId of configIds) {
        const preparedId = cwd
          ? s.preparedSessions?.[prepareChatKey(configId, cwd, undefined)]
          : null
        const prepared = preparedId ? s.sessions?.[preparedId] : null
        const cache = s.agentOptionsCache?.[configId]
        out.push(
          prepared?.models ?? cache?.models ?? null,
          prepared?.configOptions ?? cache?.configOptions ?? null
        )
      }
      return out
    })
  )
  return useMemo(
    () =>
      configIds.map((_, i) => ({
        models: flat[i * 2] as Parameters<typeof catalogFromSessionState>[0],
        configOptions: flat[i * 2 + 1] as Parameters<typeof catalogFromSessionState>[1]
      })),
    [configIds, flat]
  )
}

/**
 * Model lists for several other agents, from memory or the saved lists only.
 * Never starts an agent (search uses this).
 */
export function useKnownCatalogs(
  cwd: string,
  configIds: readonly string[]
): Array<ModelCatalog | null> {
  const memory = useMemoryState(cwd, configIds)
  const saved = usePersistedCatalogs(useShallow((s) => configIds.map((id) => s.byConfig[id])))
  return useMemo(
    () =>
      configIds.map(
        (_, i) =>
          catalogFromSessionState(memory[i].models, memory[i].configOptions) ??
          catalogFromPersisted(saved[i])
      ),
    [configIds, memory, saved]
  )
}

/**
 * The model list for one other agent's tab. Uses memory, then the saved list.
 * When neither has a list and `autoLoad` is set, starts that agent silently
 * (`prepareChat`, the same warm prepare that arming a switch runs) once.
 */
export function useOtherAgentCatalog(
  workspace: { cwd: string; projectId: string },
  configId: string | null,
  autoLoad: boolean
): {
  catalog: ModelCatalog | null
  loading: boolean
  error: PrepareChatError | null
  retry: () => void
} {
  const ids = useMemo(() => (configId ? [configId] : []), [configId])
  const { cwd, projectId } = workspace
  const [known] = useKnownCatalogs(cwd, ids)
  const savedRead = usePersistedCatalogs((s) => (configId ? configId in s.byConfig : false))
  const key = configId && cwd ? prepareChatKey(configId, cwd, undefined) : null
  const loading = useAcpStore((s) => Boolean(key && s.preparingChatKeys?.[key]))
  const error = useAcpStore((s) => (key ? (s.prepareChatErrors?.[key] ?? null) : null))
  const requested = useRef(new Set<string>())

  const prepare = useCallback(() => {
    if (!configId || !cwd) return
    void logFrontendError({
      level: 'info',
      source: 'composer.selector.loadModels',
      message: `Starting ${configId} silently in ${cwd} to read its models`
    })
    useAcpStore.getState().prepareChat(configId, cwd, undefined, projectId, { silent: true })
  }, [configId, cwd, projectId])

  useEffect(() => {
    if (configId) loadPersistedCatalog(configId)
  }, [configId])

  useEffect(() => {
    if (!autoLoad || !configId || known || !savedRead || loading || error) return
    if (requested.current.has(configId)) return
    requested.current.add(configId)
    prepare()
  }, [autoLoad, configId, known, savedRead, loading, error, prepare])

  useEffect(() => {
    if (!error || !configId) return
    void logFrontendError({
      level: 'warn',
      source: 'composer.selector.loadModels',
      message: `Could not read models for ${configId}: ${error.label}: ${error.detail}`
    })
  }, [error, configId])

  return {
    catalog: known ?? null,
    loading: loading && !known,
    error: known ? null : error,
    retry: prepare
  }
}
