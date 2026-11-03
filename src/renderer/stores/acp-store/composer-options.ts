import { type PersistedComposerOptions, PersistenceKeys } from '@shared/types/persistence.types'
import {
  MODE_CATEGORY,
  MODEL_CATEGORY,
  storedConfigValue
} from '@/components/chat/chat-input-bar-config'
import type { SessionConfigOption, SessionId } from '@/lib/acp-api'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { ephemeralSessionIds } from './ephemeral-ids'

/** Option values by option id, as stored: booleans are `"true"` / `"false"`. */
export type OptionValues = Record<string, string>

/**
 * Persist composer selections (model/mode/config) per agent-config-id via
 * `persistenceApi` (debounced). Called from the store setters so running-chatbox
 * selection changes are captured regardless of which surface triggered them.
 * Merges the patch into the existing record (not a full overwrite) so a
 * single-field change (e.g. config) doesn't wipe the persisted model. Skips
 * ephemeral/warm-pool sessions so agent defaults don't overwrite the user's
 * real last selection. Best-effort — a persistence failure logs a warn and
 * does not throw (the selection still applied to the live session).
 *
 * ## Concurrency: per-key serialization
 *
 * Each call does read-merge-write. Without serialization, two concurrent
 * calls (e.g. setModel + setMode firing in the same tick) can both read the
 * same prior record, then the second write overwrites the first's field. The
 * `composerOptionQueues` map chains promises per key so each patch reads the
 * latest in-flight record immediately before writing.
 */
export const composerOptionQueues = new Map<string, Promise<void>>()

/**
 * The newest merged record per key until its debounced write flushes: a read
 * right after a pick sees the pick without waiting out the debounce.
 */
const unflushedRecords = new Map<string, PersistedComposerOptions>()

async function readRecord(key: string): Promise<PersistedComposerOptions | null> {
  const unflushed = unflushedRecords.get(key)
  if (unflushed) return unflushed
  const result = await persistenceApi.read<PersistedComposerOptions>(key)
  return result.success ? (result.data ?? null) : null
}

function warnPersistFailure(configId: string, err: unknown): void {
  void logFrontendError({
    level: 'warn',
    source: 'acp-store.persistComposerOptions',
    message: `persist failed for ${configId}: ${err instanceof Error ? err.message : String(err)}`
  })
}

export function persistComposerOptions(
  configId: string,
  patch: PersistedComposerOptions,
  sessionId?: SessionId
): void {
  if (sessionId && ephemeralSessionIds.has(sessionId)) return
  const key = PersistenceKeys.lastComposerOptions(configId)
  const prev = composerOptionQueues.get(key) ?? Promise.resolve()
  const next = prev.then(async () => {
    const existing = (await readRecord(key)) ?? {}
    // An undefined patch field is "not part of this pick", never a reset: an
    // armed-switch effort change must not wipe the saved model.
    const merged: PersistedComposerOptions = { ...existing }
    for (const k of Object.keys(patch) as (keyof PersistedComposerOptions)[]) {
      if (patch[k] !== undefined) Object.assign(merged, { [k]: patch[k] })
    }
    // Deep-merge configValues so a single config change doesn't wipe
    // sibling config values persisted from a prior selection.
    if (existing.configValues && patch.configValues) {
      merged.configValues = { ...existing.configValues, ...patch.configValues }
    }
    // Per model too: an effort change on one model keeps the others' values.
    if (existing.modelValues && patch.modelValues) {
      const modelValues = { ...existing.modelValues }
      for (const [modelId, values] of Object.entries(patch.modelValues)) {
        modelValues[modelId] = { ...modelValues[modelId], ...values }
      }
      merged.modelValues = modelValues
    }
    unflushedRecords.set(key, merged)
    void Promise.resolve()
      .then(() => persistenceApi.writeDebounced(key, merged))
      .catch((err: unknown) => warnPersistFailure(configId, err))
      .finally(() => {
        if (unflushedRecords.get(key) === merged) unflushedRecords.delete(key)
      })
  })
  composerOptionQueues.set(key, next)
  next.catch((err) => warnPersistFailure(configId, err))
  // Clean up the queue entry once settled to avoid unbounded growth.
  next.finally(() => {
    if (composerOptionQueues.get(key) === next) composerOptionQueues.delete(key)
  })
}

/** The saved record for an agent config, including queued and unflushed picks. */
export async function readComposerOptions(
  configId: string
): Promise<PersistedComposerOptions | null> {
  const key = PersistenceKeys.lastComposerOptions(configId)
  const queued = composerOptionQueues.get(key)
  if (queued) await queued.catch(() => {})
  return readRecord(key)
}

/**
 * Effort, Fast and the like: an option whose value belongs to the model it was
 * set on. The model itself and mode (Claude's permission mode is a
 * `mode`-category option) stay agent-wide.
 */
export function isScopedOption(option: SessionConfigOption): boolean {
  return option.category !== MODEL_CATEGORY && option.category !== MODE_CATEGORY
}

/** The entries of `values` whose option `options` lists as scoped; unknown ones are dropped. */
export function scopedValues(
  values: OptionValues,
  options: readonly SessionConfigOption[]
): OptionValues {
  return Object.fromEntries(
    Object.entries(values).filter(([optionId]) => {
      const option = options.find((o) => o.id === optionId)
      return option != null && isScopedOption(option)
    })
  )
}

/**
 * The entries of `values` that stay put across a model pick: mode-category
 * ones. With no options known yet every entry stays, and the live apply skips
 * what the session does not advertise.
 */
export function agentWideValues(
  values: OptionValues,
  options: readonly SessionConfigOption[]
): OptionValues {
  if (options.length === 0) return { ...values }
  return Object.fromEntries(
    Object.entries(values).filter(
      ([optionId]) => options.find((o) => o.id === optionId)?.category === MODE_CATEGORY
    )
  )
}

/** The values saved for `modelId`. A model never tuned, or a record from before per-model values, has none. */
export function savedModelValues(
  saved: PersistedComposerOptions | null | undefined,
  modelId: string | null | undefined
): OptionValues {
  return (modelId ? saved?.modelValues?.[modelId] : undefined) ?? {}
}

/**
 * The flat saved values that do not follow the model: mode-category ones, or
 * every non-model value on a record from before per-model values. Before any
 * option is known (a cold start) the kinds are guessed: the model's own entry
 * holds the saved model, and a per-model record lists its scoped ids under
 * `modelValues`. The live apply skips what the session does not advertise.
 */
export function savedAgentWideValues(
  saved: PersistedComposerOptions | null | undefined,
  options: readonly SessionConfigOption[]
): OptionValues {
  const scopedIds = new Set(Object.values(saved?.modelValues ?? {}).flatMap(Object.keys))
  const values: OptionValues = {}
  for (const [optionId, value] of Object.entries(saved?.configValues ?? {})) {
    if (options.length === 0) {
      if (value !== saved?.modelId && !scopedIds.has(optionId)) values[optionId] = value
      continue
    }
    const option = options.find((o) => o.id === optionId)
    if (!option || option.category === MODEL_CATEGORY) continue
    if (saved?.modelValues && isScopedOption(option)) continue
    values[optionId] = value
  }
  return values
}

/** `values` without the entries `options` lists as scoped; unknown ones stay. */
export function unscopedValues(
  values: OptionValues,
  options: readonly SessionConfigOption[]
): OptionValues {
  return Object.fromEntries(
    Object.entries(values).filter(([optionId]) => {
      const option = options.find((o) => o.id === optionId)
      return option == null || !isScopedOption(option)
    })
  )
}

/** The `modelValues` patch that remembers the scoped entries of `values` for `modelId`. */
export function modelValuesPatch(
  modelId: string | null | undefined,
  values: OptionValues,
  options: readonly SessionConfigOption[]
): Pick<PersistedComposerOptions, 'modelValues'> {
  const own = scopedValues(values, options)
  if (!modelId || Object.keys(own).length === 0) return {}
  return { modelValues: { [modelId]: own } }
}

/** The current value of every scoped option: what a favorite snapshots. */
export function liveOptionValues(options: readonly SessionConfigOption[]): OptionValues {
  const values: OptionValues = {}
  for (const option of options) {
    if (!isScopedOption(option)) continue
    const stored = storedConfigValue(option)
    if (stored != null) values[option.id] = stored
  }
  return values
}

/**
 * Reopened chats put back on their own model and values. The agent-wide
 * reapply leaves a chat alone while its restore runs and once it succeeded.
 */
export const reopenRestores = new Map<SessionId, 'restoring' | 'restored'>()

/**
 * Options the user set on a chat while its reopen restore ran: the restore
 * leaves them as the user set them.
 */
const restoreUserPicks = new Map<SessionId, Set<string>>()

/** Note a user pick; it matters only while the chat's reopen restore runs. */
export function noteUserPick(sessionId: SessionId, optionId: string): void {
  if (reopenRestores.get(sessionId) !== 'restoring') return
  const picks = restoreUserPicks.get(sessionId) ?? new Set<string>()
  picks.add(optionId)
  restoreUserPicks.set(sessionId, picks)
}

export function userPickedDuringRestore(sessionId: SessionId, optionId: string): boolean {
  return restoreUserPicks.get(sessionId)?.has(optionId) ?? false
}

export function endRestoreUserPicks(sessionId: SessionId): void {
  restoreUserPicks.delete(sessionId)
}

/**
 * Each chat's newest in-flight model pick (`pickModel`) and armed-switch
 * model pick: an older pick stops at its next step. An entry exists only
 * while its pick runs.
 */
export const latestModelPick = new Map<SessionId, number>()
export const latestArmedPick = new Map<SessionId, number>()
let pickSeq = 0

export function nextPickSeq(): number {
  pickSeq += 1
  return pickSeq
}

/** Warn keys already logged, so reapply (run on every options event) logs once. */
const warnedOnce = new Set<string>()

export function warnOnce(sessionId: SessionId, key: string, source: string, message: string): void {
  const warnKey = `${sessionId}\0${key}`
  if (warnedOnce.has(warnKey)) return
  warnedOnce.add(warnKey)
  void logFrontendError({ level: 'warn', source, message })
}

/** Drop a removed session's restore mark, pick marks and warn keys. */
export function forgetComposerSession(sessionId: SessionId): void {
  reopenRestores.delete(sessionId)
  restoreUserPicks.delete(sessionId)
  latestModelPick.delete(sessionId)
  latestArmedPick.delete(sessionId)
  const prefix = `${sessionId}\0`
  for (const key of warnedOnce) if (key.startsWith(prefix)) warnedOnce.delete(key)
}

export function _resetComposerSessionsForTesting(): void {
  reopenRestores.clear()
  restoreUserPicks.clear()
  latestModelPick.clear()
  latestArmedPick.clear()
  unflushedRecords.clear()
  warnedOnce.clear()
}
