/**
 * "Create automation" on a suggestion: a new chat in the project, on the
 * default agent, seeded with a prompt that asks the agent to build the
 * automation. It opens through the same placeholder launch as the agent
 * launcher, so the chat paints the prompt at once.
 */

import type { AutomationSuggestion } from '@shared/types/automation.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { toast } from 'sonner'
import type { ContentBlock } from '@/lib/acp-api'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useAcpStore } from '@/stores/acp-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

const SOURCE = 'automations.suggestions'

export function suggestionPrompt(suggestion: AutomationSuggestion): string {
  return (
    `Turn this repeated request into a scheduled background automation: «${suggestion.representative}». ` +
    `I've asked it on ${suggestion.days} days, usually ${suggestion.cadence.label}. ` +
    'Ask me at most 3 questions with your question tool (schedule, where results go), ' +
    'then build it with the automation tools and propose it.'
  )
}

/**
 * Opens the chat and sends the prompt. Without a ready default agent the
 * launcher opens with the prompt as its draft, so the user picks one.
 * `false` when the prompt reached neither, so the suggestion stays open.
 */
export async function launchSuggestionChat(
  projectId: string,
  suggestion: AutomationSuggestion
): Promise<boolean> {
  const text = suggestionPrompt(suggestion)
  const store = useAcpStore.getState()
  const cwd = getDefaultCwdForProject(projectId)
  if (!cwd) {
    toast.error('Could not create the automation: the project has no folder')
    void logFrontendError({
      level: 'warn',
      source: SOURCE,
      message: `suggestion=${suggestion.fingerprint} not launched: project ${projectId} has no folder`
    })
    return false
  }
  const config = store.agentConfigs.find((c) => c.id === store.selectedAgentConfigId)
  if (!config) {
    const draft = await persistenceApi.write(PersistenceKeys.lastLaunchDraft(projectId), text)
    if (!draft.success) {
      toast.error('Could not open the launcher with the automation prompt')
      void logFrontendError({
        level: 'warn',
        source: SOURCE,
        message: `suggestion=${suggestion.fingerprint} launcher draft write failed: ${draft.error}`
      })
      return false
    }
    const paneId = useWorkspaceStore.getState().activePaneId
    if (paneId) useWorkspaceStore.getState().showAgentLauncher(paneId)
    toast('Pick an agent to build the automation')
    void logFrontendError({
      level: 'info',
      source: SOURCE,
      message: `suggestion=${suggestion.fingerprint} opened the launcher: no default agent`
    })
    return true
  }

  const blocks: ContentBlock[] = [{ type: 'text', text }]
  const placeholderId = store.createLaunchPlaceholder({
    cwd,
    projectId,
    initialUserBlocks: blocks
  })
  useWorkspaceStore.getState().addAgentChatTab(placeholderId)
  try {
    const sessionId = await store.finalizeChatLaunch({
      placeholderId,
      configId: config.id,
      cwd,
      projectId,
      pending: null,
      initialText: null,
      initialBlocks: blocks,
      adoptSession: (from, to) => useWorkspaceStore.getState().remapAgentChatSession(from, to)
    })
    void logFrontendError({
      level: 'info',
      source: SOURCE,
      message: `suggestion=${suggestion.fingerprint} started chat ${sessionId}`
    })
    return true
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to start the chat')
    void logFrontendError({
      level: 'warn',
      source: SOURCE,
      message: `suggestion=${suggestion.fingerprint} chat launch failed`
    })
    return false
  }
}
