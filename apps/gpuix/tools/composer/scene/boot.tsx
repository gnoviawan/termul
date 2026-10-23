/**
 * GPUIX side of the composer scene: the shared `ChatInputBar` (through compat,
 * with the native composer override) for a chat this client starts with the
 * prompt-logging agent, placed at the box the web client gives its composer.
 */

import { render } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { ChatInputBar } from '@/components/chat/ChatInputBar'
import { useAcpListeners } from '@/hooks/use-acp-listeners'
import { useProjectRegistry } from '@/hooks/use-project-registry'
import { getAcpTransport } from '@/lib/acp-transport'
import { checkWebAuthGate } from '@/lib/web-auth-gate'
import { setWebAuthToken } from '@/lib/web-auth-token'
import { ensureClientIdentity } from '@/lib/web-client-identity'
import { useAcpStore } from '@/stores/acp-store'
import { CompatRoot, compatRenderOptions } from '../../../src/compat/root'
import { log } from '../../../src/log'
import { tw } from '../../../src/style/tw'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import type { ComposerSceneBoot, SceneBox, SceneStart } from './contract'

const NO_COMMANDS: never[] = []

function useStartedChat(start: SceneStart, onSession: (id: string) => void): string | null {
  const [sessionId, setSessionId] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      await useAcpStore.getState().loadAgentConfigs()
      const id = await useAcpStore
        .getState()
        .startChat(start.configId, start.cwd, undefined, start.projectId)
      log.info('composer-scene', `started ${id}`)
      if (!cancelled) {
        setSessionId(id)
        onSession(id)
      }
    }
    run().catch((error: unknown) => log.warn('composer-scene', `start failed: ${String(error)}`))
    return () => {
      cancelled = true
    }
  }, [start, onSession])
  return sessionId
}

function Composer({ sessionId, box }: { sessionId: string; box: SceneBox }) {
  const session = useAcpStore((s) => s.sessions[sessionId])
  const commands = useAcpStore((s) => s.commands[sessionId] ?? NO_COMMANDS)
  if (!session) return null
  const store = useAcpStore.getState()
  return (
    <div
      testId="composer-scene-ready"
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.width,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {commands.length > 0 ? (
        <div
          testId="composer-scene-commands"
          style={{ position: 'absolute', width: 1, height: 1 }}
        />
      ) : null}
      <ChatInputBar
        session={session}
        busy={session.activeTurn}
        disabled={false}
        onSend={(text) => void store.sendPrompt(sessionId, text)}
        onSendBlocks={(blocks, displayBlocks) =>
          void store.sendPromptBlocks(sessionId, blocks, { displayBlocks })
        }
        onCancel={() => void store.cancelPrompt(sessionId)}
        commands={commands}
        configOptions={session.configOptions ?? []}
        modes={session.modes ?? null}
        onSetConfig={() => {}}
        onSetMode={() => {}}
        onSetModel={() => {}}
        isVisible
      />
    </div>
  )
}

function Scene({
  start,
  box,
  onSession
}: {
  start: SceneStart
  box: SceneBox
  onSession: (id: string) => void
}) {
  useProjectRegistry()
  useAcpListeners()
  const sessionId = useStartedChat(start, onSession)
  return (
    <div
      style={{
        ...tw('bg-terminal-bg'),
        position: 'absolute',
        left: 0,
        top: 0,
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT
      }}
    >
      {sessionId ? <Composer sessionId={sessionId} box={box} /> : null}
    </div>
  )
}

export const boot: ComposerSceneBoot = (config, options) => {
  if (config.token) setWebAuthToken(config.token)
  ensureClientIdentity()
  checkWebAuthGate()
  getAcpTransport()
    .connect()
    .catch(() => {})
  render(
    <CompatRoot onRenderer={options.onRenderer}>
      <Scene start={options.start} box={options.box} onSession={options.onSession} />
    </CompatRoot>,
    {
      title: 'Termul composer scene',
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      focus: false,
      ...compatRenderOptions
    }
  )
}
