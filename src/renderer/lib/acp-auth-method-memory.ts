/**
 * Persistence for the per-config remembered ACP auth method
 * (spec-acp-persistent-auth-reuse).
 *
 * Maps `configId` → the `AuthMethod.id` that last completed `authenticate`
 * for that configured agent, under a dedicated `persistenceApi` key. Only the
 * method id is stored — never tokens or credentials. When a fresh agent
 * process for the same config answers a session call with auth-required and
 * advertises multiple methods, the remembered id is the ONLY method Termul
 * may auto-authenticate with; otherwise the user picks (never silently
 * choose).
 */

import { PersistenceKeys } from '@shared/types/persistence.types'
import { persistenceApi } from '@/lib/api'

/** `configId` → `methodId` of the last successful `authenticate`. */
export type AuthMethodMemory = Record<string, string>

/**
 * Sanitize a stored value: a corrupt/non-map payload must never crash startup —
 * drop anything that is not a non-empty-string → non-empty-string entry rather
 * than trusting the persisted JSON shape.
 */
export function normalizeAuthMethodMemory(data: unknown): AuthMethodMemory {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  const clean: AuthMethodMemory = {}
  for (const [key, value] of Object.entries(data)) {
    const configId = key.trim()
    if (configId.length === 0) continue
    if (typeof value !== 'string' || value.trim().length === 0) continue
    clean[configId] = value.trim()
  }
  return clean
}

/** Load persisted auth-method memory (empty map when none stored). */
export async function loadAuthMethodMemory(): Promise<AuthMethodMemory> {
  const res = await persistenceApi.read<unknown>(PersistenceKeys.acpAuthMethods)
  if (res.success) return normalizeAuthMethodMemory(res.data)
  // A missing key is the normal empty state; any other failure is a real
  // storage/backend error and must not be silently collapsed to {}.
  if (res.code === 'KEY_NOT_FOUND') return {}
  throw new Error(res.error ?? 'Failed to load auth-method memory')
}

/** Persist the full configId → methodId memory map. */
export async function saveAuthMethodMemory(map: AuthMethodMemory): Promise<void> {
  const res = await persistenceApi.write(PersistenceKeys.acpAuthMethods, map)
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to persist auth-method memory')
  }
}
