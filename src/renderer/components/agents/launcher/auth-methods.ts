import type { AuthMethod } from '@/lib/acp-api'

/**
 * An agent's advertised sign-in methods by what Termul can do with them.
 * `runnable`: 'agent' (and untyped, the pre-extension wire) and 'terminal'
 * methods, which a button drives. `apiKey`: agent methods that take a key
 * the user types. `gateway`: the gateway method, which needs a base URL
 * first. `guidance`: 'env_var' and future variants, which are advertised for
 * completeness and only shown as text.
 */
export interface AuthMethodGroups {
  runnable: AuthMethod[]
  apiKey: AuthMethod[]
  gateway: AuthMethod | undefined
  guidance: AuthMethod[]
}

export function partitionAuthMethods(methods: readonly AuthMethod[]): AuthMethodGroups {
  const actionable = methods.filter((m) => m.id.trim().length > 0)
  const drivable = (m: AuthMethod): boolean =>
    m.type === 'agent' || m.type === 'terminal' || m.type == null
  const keyed = (m: AuthMethod): boolean => m.takesApiKey === true && m.type !== 'terminal'
  const signIns = actionable.filter((m) => m.id !== 'gateway' && drivable(m))
  return {
    runnable: signIns.filter((m) => !keyed(m)),
    apiKey: signIns.filter(keyed),
    gateway: actionable.find((m) => m.id === 'gateway'),
    guidance: actionable.filter((m) => !drivable(m))
  }
}
