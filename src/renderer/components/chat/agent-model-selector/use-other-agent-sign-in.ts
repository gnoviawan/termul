import { EMPTY_AUTH_METHODS } from '@/components/agents/launcher/constants'
import { authMethodRoute, useAgentSignIn } from '@/components/agents/launcher/use-agent-sign-in'
import { agentPolicy } from '@/lib/agents/acp-registry'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import { agentReuseKey } from '@/stores/acp-reuse-keys'
import { useAcpStore } from '@/stores/acp-store'
import type { AgentTab } from './selector-model'
import type { SelectorSource } from './selector-source'

/** One sign-in method as a row: what it says and whether it can run now. */
export interface SignInAction {
  key: string
  label: string
  title: string | undefined
  /** This method's sign-in is running. */
  busy: boolean
  disabled: boolean
  onSelect: () => void
}

/**
 * Another agent's sign-in, offered in place when reading its models failed
 * because it is signed out.
 */
export interface SelectorSignIn {
  actions: SignInAction[]
  /** Methods only a new chat can drive (gateway URL, inline key). */
  note: string | null
}

/**
 * The sign-in methods of the agent on another tab whose silent model read
 * failed on auth (`auth` or `multi-auth`), dispatched the way the launcher
 * dispatches them. `onSignedIn` reads the models again. Null when the tab has
 * no auth failure or its agent advertised no method.
 */
export function useOtherAgentSignIn(
  source: SelectorSource,
  tab: AgentTab | null,
  error: PrepareChatError | null,
  onSignedIn: () => void
): SelectorSignIn | null {
  const { cwd, projectId } = source.workspace
  const signedOut = error?.category === 'auth' || error?.category === 'multi-auth'
  // The silent prepare passes the chat's Project, so its live agent sits
  // under the Project-scoped reuse key.
  const reuseKey =
    signedOut && tab && cwd ? agentReuseKey(tab.configId, cwd, projectId || undefined) : null
  const agentId = useAcpStore((s) => (reuseKey ? (s.configToLiveAgent?.[reuseKey] ?? null) : null))
  const methods = useAcpStore((s) =>
    agentId ? (s.agents?.[agentId]?.authMethods ?? EMPTY_AUTH_METHODS) : EMPTY_AUTH_METHODS
  )
  const { signingInMethodId, runAuthenticate, runTerminalAuth } = useAgentSignIn(
    {
      agentId,
      config: tab?.config ?? null,
      cwd,
      projectId: projectId || null,
      resolvePaneId: source.signInPaneId,
      logSource: 'composer.selector.signIn'
    },
    onSignedIn
  )

  const shown = methods.filter((m) => m.id.trim().length > 0)
  if (!tab || !agentId || shown.length === 0) return null

  const auth = tab.entry ? agentPolicy(tab.entry.id).auth : null
  const inlineKeyMethodId = auth?.mode === 'acp' ? auth.inlineKeyFormMethodId : undefined
  const actions: SignInAction[] = []
  const newChatOnly: string[] = []
  for (const method of shown) {
    const route = authMethodRoute(method, inlineKeyMethodId)
    if (route === 'agent' || route === 'terminal') {
      const busy = signingInMethodId === method.id
      actions.push({
        key: method.id,
        label: busy ? `Signing in with ${method.name}…` : method.name,
        title: method.description ?? undefined,
        busy,
        disabled: signingInMethodId !== null,
        onSelect: () => {
          if (route === 'agent') void runAuthenticate(method.id)
          else void runTerminalAuth(method)
        }
      })
    } else if (route === 'unsupported') {
      actions.push({
        key: method.id,
        label: `${method.name} (not supported)`,
        title: `${method.name} is not supported yet`,
        busy: false,
        disabled: true,
        onSelect: () => {}
      })
    } else {
      newChatOnly.push(method.name)
    }
  }
  return {
    actions,
    note:
      newChatOnly.length > 0
        ? `To sign in with ${newChatOnly.join(' or ')}, start a new chat with ${tab.name}.`
        : null
  }
}
