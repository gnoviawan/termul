import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useResolvedSupportedAcpAgents } from '@/hooks/use-resolved-supported-acp-agents'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import { acpApi } from '@/lib/acp-api'
import {
  installedBinaryConfig,
  type SupportedAcpAgentEntry
} from '@/lib/agents/supported-acp-agents'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { waitForTurnClear } from '@/stores/prompt-queue-orchestration'

const EMPTY_CONFIGS: readonly StoredAgentConfig[] = []

/** A model picked on another agent's tab: armed with the switch. */
export interface SwitchModelPick {
  modelId: string
  /** The target's model config option id, when its list came from one. */
  modelConfigId: string | null
}

/**
 * The current agent config of a chat: the live reuse-key map first, then the
 * session index (a restored chat before its agent reconnects).
 */
export function useCurrentAgentConfigId(sessionId: string): string | null {
  return useAcpStore((s) => {
    const session = s.sessions?.[sessionId]
    if (session?.agentId) {
      for (const [key, id] of Object.entries(s.configToLiveAgent ?? {})) {
        if (id === session.agentId) return key.split('\0')[0]
      }
    }
    return s.sessionIndex?.find((entry) => entry.id === sessionId)?.agentConfigId ?? null
  })
}

/**
 * The switch gate as the selector shows it. `blocked` mirrors the raw fields
 * the store's `switchBlockedReason` reads: an active or open turn, a replay,
 * a launching chat, queued prompts, a pending permission or question, and a
 * pending browser sign-in. `turnBusy` is the one state that cancel-then-switch
 * can clear: a live turn with nothing else blocking. Cancelling a turn while
 * prompts stay queued would let the next prompt start at once, so the arm
 * would fail after the user already cancelled.
 */
export function useSwitchGate(sessionId: string): { blocked: boolean; turnBusy: boolean } {
  const blocked = useAcpStore((s) => {
    const session = s.sessions?.[sessionId]
    if (!session) return false
    if (session.activeTurn || session.openTurnId || session.replaying) return true
    if (s.launchingSessionIds?.[sessionId]) return true
    if ((s.promptQueues?.[sessionId] ?? []).length > 0) return true
    if (Object.values(s.pendingPermissions ?? {}).some((p) => p.sessionId === sessionId)) {
      return true
    }
    if (Object.values(s.pendingQuestions ?? {}).some((q) => q.sessionId === sessionId)) return true
    return Boolean(session.agentId && s.pendingBrowserOpen?.[session.agentId])
  })
  const turnBusy = useAcpStore((s) => {
    const session = s.sessions?.[sessionId]
    if (!session?.activeTurn && !session?.openTurnId) return false
    if ((s.promptQueues?.[sessionId] ?? []).length > 0) return false
    if (Object.values(s.pendingPermissions ?? {}).some((p) => p.sessionId === sessionId)) {
      return false
    }
    if (Object.values(s.pendingQuestions ?? {}).some((q) => q.sessionId === sessionId)) {
      return false
    }
    if (s.launchingSessionIds?.[sessionId] || session.replaying) return false
    return !(session.agentId && s.pendingBrowserOpen?.[session.agentId])
  })
  return { blocked, turnBusy }
}

/**
 * Agent switching for the composer selector: the resolved agent list, the
 * switch gate, arming with a model, cancel-then-switch, and the install
 * driver. The store owns the gate and its banner; this hook only mirrors the
 * gate fields and calls the store actions.
 */
export function useAgentSwitch(sessionId: string): {
  agentConfigs: readonly StoredAgentConfig[]
  entries: readonly SupportedAcpAgentEntry[]
  currentConfigId: string | null
  armedConfigId: string | null
  blocked: boolean
  turnBusy: boolean
  installingConfigId: string | null
  armWithModel: (configId: string, pick: SwitchModelPick | null) => Promise<boolean>
  cancelThenSwitch: (configId: string, pick: SwitchModelPick | null) => Promise<void>
  install: (entry: SupportedAcpAgentEntry) => void
} {
  const agentConfigs = useAcpStore((s) => s.agentConfigs ?? EMPTY_CONFIGS)
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const armedConfigId = useAcpStore((s) => s.sessions?.[sessionId]?.switching?.toConfigId ?? null)
  const currentConfigId = useCurrentAgentConfigId(sessionId)
  const entries = useResolvedSupportedAcpAgents(agentConfigs)
  const { blocked, turnBusy } = useSwitchGate(sessionId)
  const [installingConfigId, setInstallingConfigId] = useState<string | null>(null)

  const armWithModel = useCallback(
    async (configId: string, pick: SwitchModelPick | null): Promise<boolean> => {
      const store = useAcpStore.getState()
      // Arm failures are store-owned: the busy gate and unknown-config
      // rejection stamp the chat's banner and log.
      const armed = await store.armAgentSwitch(sessionId, configId)
      if (!armed || !pick) return armed
      try {
        await useAcpStore
          .getState()
          .setSwitchPendingOption(
            sessionId,
            pick.modelConfigId
              ? { modelId: pick.modelId, configValues: { [pick.modelConfigId]: pick.modelId } }
              : { modelId: pick.modelId }
          )
      } catch (err) {
        void logFrontendError({
          level: 'warn',
          source: 'composer.selector.armWithModel',
          message: `Armed ${configId} for ${sessionId} but the model pick failed: ${String(err)}`
        })
        toast.error('The agent switch is set, but the model was not saved. Choose it again.')
      }
      return true
    },
    [sessionId]
  )

  // Cancel-then-switch: cancelPrompt → waitForTurnClear → arm, the same
  // recipe as `sendQueuedPromptNow`, so the busy gate is never skipped.
  const cancelThenSwitch = useCallback(
    async (configId: string, pick: SwitchModelPick | null): Promise<void> => {
      try {
        await useAcpStore.getState().cancelPrompt(sessionId)
        await waitForTurnClear(sessionId, useAcpStore.getState, useAcpStore.subscribe)
        await armWithModel(configId, pick)
      } catch (err) {
        void logFrontendError({
          level: 'warn',
          source: 'composer.selector.cancelThenSwitch',
          message: `Cancel-then-switch to ${configId} failed for ${sessionId}: ${String(err)}`
        })
        toast.error(`Could not switch the agent: ${String(err)}`)
      }
    },
    [armWithModel, sessionId]
  )

  // Install driver (the launcher's handleInstallAgent recipe): host install →
  // installedBinaryConfig → saveAgentConfig. The entries then re-resolve as
  // ready and the tab loads that agent's models.
  const install = useCallback(
    (entry: SupportedAcpAgentEntry) => {
      const spec = entry.install
      if (!spec || installingConfigId) return
      setInstallingConfigId(entry.configId)
      void (async () => {
        try {
          const installed = await acpApi.installAcpAgent(entry.agent.id)
          const config = installedBinaryConfig(
            entry.agent,
            installed,
            spec.kind === 'archive' ? { env: spec.env } : {}
          )
          await saveAgentConfig(config)
          toast.success(`${entry.agent.name} installed`)
        } catch (err) {
          void logFrontendError({
            level: 'warn',
            source: 'composer.selector.install',
            message: `Install of ${entry.agent.id} failed: ${String(err)}`
          })
          toast.error(`Failed to install ${entry.agent.name}: ${String(err)}`)
        } finally {
          setInstallingConfigId(null)
        }
      })()
    },
    [installingConfigId, saveAgentConfig]
  )

  return {
    agentConfigs,
    entries,
    currentConfigId,
    armedConfigId,
    blocked,
    turnBusy,
    installingConfigId,
    armWithModel,
    cancelThenSwitch,
    install
  }
}
