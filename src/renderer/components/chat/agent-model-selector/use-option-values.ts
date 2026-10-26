import type { PersistedRejectedOptionValues } from '@shared/types/persistence.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { useEffect, useState } from 'react'
import type { SessionConfigOption } from '@/lib/acp-api'
import { isOutcomeUncertainError } from '@/lib/acp-transport/types'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'

export const REJECTED_TITLE = 'Not available for this agent'

/**
 * Serialized read-modify-write chain per agent config for persisted option
 * rejections: a closure-local record is NOT a queue — two concurrent
 * persistRejection calls could still race their reads and the last write
 * would lose the first value (review). Mirrors composerOptionQueues.
 */
const rejectionWriteQueues = new Map<string, Promise<void>>()

function persistRejection(agentConfigId: string, optionId: string, value: string): void {
  const key = PersistenceKeys.agentRejectedOptionValues(agentConfigId)
  const prev = rejectionWriteQueues.get(key) ?? Promise.resolve()
  // Each write reads the CURRENT stored record inside the chain, so two
  // rejections can never race their reads against each other.
  const next = prev.then(async () => {
    const result = await persistenceApi.read<PersistedRejectedOptionValues>(key)
    const record: PersistedRejectedOptionValues = {}
    // A failed read is treated as an empty record and only ever merged —
    // never written back on its own — so it cannot wipe stored rejections.
    if (result.success && result.data) {
      for (const [id, values] of Object.entries(result.data)) record[id] = values
    }
    const values = new Set(record[optionId] ?? [])
    values.add(value)
    record[optionId] = [...values]
    const write = await persistenceApi.write(key, { ...record })
    if (!write.success) {
      void logFrontendError({
        level: 'warn',
        source: 'selector.rejectedOptionValues',
        message: 'failed to persist a rejected option value (details withheld)'
      })
    }
  })
  rejectionWriteQueues.set(
    key,
    next.finally(() => {
      if (rejectionWriteQueues.get(key) === next) rejectionWriteQueues.delete(key)
    })
  )
  next.catch(() => {
    // Observed by the chain itself; nothing further to do.
  })
}

const NONE: Record<string, true> = {}

interface RejectedState {
  agent: string | null
  /** `${optionId}::${value}` keys, for `agent`. */
  rejected: Record<string, true>
}

/** Adds `keys` for `agent`; the side named by `keep` wins a clash. */
function withRejected(
  prev: RejectedState,
  agent: string | null,
  keys: Record<string, true>,
  keep: 'old' | 'new'
): RejectedState {
  const old = prev.agent === agent ? prev.rejected : NONE
  return { agent, rejected: keep === 'old' ? { ...keys, ...old } : { ...old, ...keys } }
}

/**
 * Values of the agent's config options that the agent has rejected. Setting
 * a value the agent rejects (e.g. a tool advertised as a segment — #1480's
 * `web-fetch`) marks it unavailable for the rest of the panel's life AND, per
 * agent config, across sessions, so the panel opens with unavailable values
 * already hidden (maintainer request on #1489). The record follows the agent:
 * one agent's rejections never show on another's options.
 */
export function useRejectedOptionValues(
  agentConfigId: string | null,
  genericOptions: readonly SessionConfigOption[],
  onSetConfig: (configId: string, valueId: string | boolean) => void | Promise<void>
): {
  isRejected: (optionId: string, value: string) => boolean
  /** Sets the value; the promise still rejects for callers that revert. */
  trySet: (optionId: string, value: string | boolean) => Promise<void>
} {
  const [state, setState] = useState<RejectedState>({ agent: agentConfigId, rejected: NONE })
  const rejected = state.agent === agentConfigId ? state.rejected : NONE

  useEffect(() => {
    if (!agentConfigId) return
    let cancelled = false
    void (async () => {
      const result = await persistenceApi.read<PersistedRejectedOptionValues>(
        PersistenceKeys.agentRejectedOptionValues(agentConfigId)
      )
      if (cancelled || !result.success || !result.data) return
      // Drop entries for options the agent no longer advertises.
      const advertised = new Set(genericOptions.map((o) => o.id))
      const flat: Record<string, true> = {}
      for (const [optionId, values] of Object.entries(result.data)) {
        if (!advertised.has(optionId)) continue
        for (const v of values) flat[`${optionId}::${v}`] = true
      }
      // Merge, never replace: this effect re-runs whenever the parent passes a
      // new genericOptions array reference, and a replace would drop
      // rejections already recorded in this panel instance (review).
      setState((prev) => withRejected(prev, agentConfigId, flat, 'old'))
    })()
    return () => {
      cancelled = true
    }
  }, [agentConfigId, genericOptions])

  const trySet = (optionId: string, value: string | boolean): Promise<void> => {
    const agent = agentConfigId
    const attempt = Promise.resolve(onSetConfig(optionId, value))
    // Observe the failure to hide the value (now and on the next open); the
    // rejection still propagates to callers that hold the promise (boolean
    // switch revert).
    void attempt.catch((error: unknown) => {
      // Only an EXPLICIT agent rejection marks the value unavailable. A
      // transport failure (disconnect/timeout/outcome-unknown) says nothing
      // about the value — hiding it would bury a valid pick (review).
      if (isOutcomeUncertainError(error)) return
      setState((prev) =>
        withRejected(prev, agent, { [`${optionId}::${String(value)}`]: true }, 'new')
      )
      if (agent && typeof value === 'string') persistRejection(agent, optionId, value)
    })
    return attempt
  }

  return {
    isRejected: (optionId, value) => rejected[`${optionId}::${value}`] === true,
    trySet
  }
}

/**
 * An on/off value that flips at once and reverts if the set is rejected.
 * The (already-toasted) rejection is swallowed after the revert; a boolean
 * cannot be marked per-value unavailable.
 */
export function useOptimisticSwitch(
  advertised: boolean,
  onToggle: (value: boolean) => void | Promise<void>
): [on: boolean, toggle: (value: boolean) => void] {
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const toggle = (value: boolean): void => {
    setOptimistic(value)
    void Promise.resolve(onToggle(value))
      .catch(() => undefined)
      .finally(() => setOptimistic(null))
  }
  return [optimistic ?? advertised, toggle]
}
