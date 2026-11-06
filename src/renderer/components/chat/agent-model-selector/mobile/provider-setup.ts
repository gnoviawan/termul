import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSignIn } from '@/components/agents/launcher/use-agent-sign-in'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { prepareChatKey } from '@/stores/acp-store/helpers'
import type { AgentTab } from '../selector-model'
import { useKnownCatalogs } from '../use-model-catalog'
import { useSelectorAgentSignIn } from '../use-selector-agent-sign-in'

/** Saving the agent's config, the one step this screen owns itself. */
export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; message: string }

/**
 * Where an agent's setup stands, in the order the screen moves through it.
 * `confirm`: no stored config yet (the chat cannot arm it). `starting`: the
 * config is stored and the agent is starting to list its models. `sign-in`:
 * it started and asked for credentials. `ready`: its models are known.
 */
export type SetupPhase =
  | { kind: 'confirm' }
  | { kind: 'saving' }
  | { kind: 'starting' }
  | { kind: 'sign-in'; error: PrepareChatError }
  | { kind: 'failed'; title: string; detail: string }
  | { kind: 'ready' }

export function setupPhase({
  stored,
  save,
  modelsKnown,
  prepareError
}: {
  stored: boolean
  save: SaveState
  modelsKnown: boolean
  prepareError: PrepareChatError | null
}): SetupPhase {
  if (save.kind === 'saving') return { kind: 'saving' }
  if (save.kind === 'failed') return { kind: 'failed', title: 'Setup failed', detail: save.message }
  if (!stored) return { kind: 'confirm' }
  if (modelsKnown) return { kind: 'ready' }
  if (prepareError?.category === 'auth' || prepareError?.category === 'multi-auth') {
    return { kind: 'sign-in', error: prepareError }
  }
  if (prepareError) {
    return { kind: 'failed', title: prepareError.label, detail: prepareError.detail }
  }
  return { kind: 'starting' }
}

export interface ProviderSetup {
  phase: SetupPhase
  /** The config this screen saves and starts. */
  config: StoredAgentConfig | null
  /** Save the config (the launcher's explicit pick does the same). */
  start: () => void
  /** After a failure: save again, or start the agent again. */
  retry: () => void
  signIn: AgentSignIn
}

/**
 * One agent's setup inside the chat's model sheet: save its config the way
 * the launcher's explicit pick does (issue #907), start it in the chat's
 * folder to read its models, and run its sign-in when it asks for one.
 */
export function useProviderSetup(
  tab: AgentTab,
  workspace: { cwd: string; projectId: string }
): ProviderSetup {
  const { cwd, projectId } = workspace
  const configId = tab.configId
  const config = tab.entry?.config ?? tab.config
  const stored = useAcpStore((s) => (s.agentConfigs ?? []).some((c) => c.id === configId))
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const key = cwd ? prepareChatKey(configId, cwd, undefined) : null
  const prepared = useAcpStore((s) => Boolean(key && s.preparedSessions?.[key]))
  const preparing = useAcpStore((s) => Boolean(key && s.preparingChatKeys?.[key]))
  const prepareError = useAcpStore((s) => (key ? (s.prepareChatErrors?.[key] ?? null) : null))
  const ids = useMemo(() => [configId], [configId])
  const [known] = useKnownCatalogs(cwd, ids)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })

  const prepare = useCallback(
    (fresh: boolean) => {
      if (!key) return
      const store = useAcpStore.getState()
      // A retry is new intent: drop the recorded failure so even a definite
      // host rejection runs again (silent prepares never retry those).
      if (fresh) store.cancelPreparedChat(key)
      store.prepareChat(configId, cwd, undefined, projectId, { silent: true })
    },
    [key, configId, cwd, projectId]
  )

  const phase = setupPhase({
    stored,
    save,
    modelsKnown: Boolean(known) || prepared,
    prepareError
  })

  // Start the agent once its config is stored, so a sign-in it needs shows
  // here instead of failing the first send.
  const started = useRef(false)
  useEffect(() => {
    if (phase.kind !== 'starting' || preparing || started.current) return
    started.current = true
    prepare(false)
  }, [phase.kind, preparing, prepare])

  useEffect(() => {
    if (!prepareError) return
    void logFrontendError({
      level: 'warn',
      source: 'composer.selector.setup',
      message: `Setup of ${configId} stopped: ${prepareError.category}: ${prepareError.label}`
    })
  }, [prepareError, configId])

  const start = useCallback(() => {
    if (!config || save.kind === 'saving') return
    setSave({ kind: 'saving' })
    void logFrontendError({
      level: 'info',
      source: 'composer.selector.setup',
      message: `Saving ${configId} so the chat can switch to it`
    })
    saveAgentConfig(config).then(
      () => setSave({ kind: 'idle' }),
      (err: unknown) => {
        void logFrontendError({
          level: 'warn',
          source: 'composer.selector.setup',
          message: `Saving ${configId} failed: ${String(err)}`
        })
        setSave({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
      }
    )
  }, [config, configId, save.kind, saveAgentConfig])

  const retry = useCallback(() => {
    if (save.kind === 'failed' || !stored) {
      start()
      return
    }
    prepare(true)
  }, [save.kind, stored, start, prepare])

  const reprepare = useCallback(() => prepare(true), [prepare])
  const signIn = useSelectorAgentSignIn(tab, workspace, reprepare)

  return { phase, config, start, retry, signIn }
}
