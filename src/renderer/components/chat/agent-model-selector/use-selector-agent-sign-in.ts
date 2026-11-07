import { useCallback } from 'react'
import { type AgentSignIn, useAgentSignIn } from '@/components/agents/launcher/use-agent-sign-in'
import type { AuthMethod } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { AgentTab } from './selector-model'

/**
 * The sign-in of an agent on one of the model selector's tabs, in the chat's
 * folder. `onSignedIn` reads its models again. The desktop panels and the
 * phone sheet's setup screen share it.
 */
export function useSelectorAgentSignIn(
  tab: AgentTab,
  workspace: { cwd: string; projectId: string },
  onSignedIn: () => void
): AgentSignIn {
  const { cwd, projectId } = workspace
  const configId = tab.configId
  const projectEnvVars = useProjectStore((s) => s.projects.find((p) => p.id === projectId)?.envVars)
  // A press inside the selector bubbles through its portal to the chat's
  // pane, which makes that pane the active one: the login terminal opens there.
  const paneId = useWorkspaceStore((s) => s.activePaneId)
  const signedIn = useCallback(() => {
    void logFrontendError({
      level: 'info',
      source: 'composer.selector.signIn',
      message: `Signed in to ${configId}; reading its models again`
    })
    onSignedIn()
  }, [configId, onSignedIn])
  const signIn = useAgentSignIn({
    registryAgentId: tab.entry?.id ?? null,
    config: tab.entry?.config ?? tab.config,
    cwd,
    projectId,
    projectEnvVars,
    paneId,
    onSignedIn: signedIn
  })
  const { handleAuthMethod } = signIn
  const handleLoggedAuthMethod = useCallback(
    (method: AuthMethod) => {
      void logFrontendError({
        level: 'info',
        source: 'composer.selector.signIn',
        message: `Signing in to ${configId} with ${method.id} (${method.type ?? 'agent'})`
      })
      handleAuthMethod(method)
    },
    [configId, handleAuthMethod]
  )
  return { ...signIn, handleAuthMethod: handleLoggedAuthMethod }
}
