import type { AuthMethod } from '@/lib/acp-api'

/**
 * An agent's advertised sign-in methods by what Termul can do with them.
 * `runnable`: 'agent' (and untyped, the pre-extension wire) and 'terminal'
 * methods, which a button drives. `gateway`: the gateway method, which needs
 * a base URL first. `guidance`: 'env_var' and future variants, which are
 * advertised for completeness and only shown as text.
 */
export interface AuthMethodGroups {
  runnable: AuthMethod[]
  gateway: AuthMethod | undefined
  guidance: AuthMethod[]
}

export function partitionAuthMethods(methods: readonly AuthMethod[]): AuthMethodGroups {
  const actionable = methods.filter((m) => m.id.trim().length > 0)
  const drivable = (m: AuthMethod): boolean =>
    m.type === 'agent' || m.type === 'terminal' || m.type == null
  return {
    runnable: actionable.filter((m) => m.id !== 'gateway' && drivable(m)),
    gateway: actionable.find((m) => m.id === 'gateway'),
    guidance: actionable.filter((m) => !drivable(m))
  }
}
