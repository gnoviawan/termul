/**
 * GPUIX side of the transcript scene: the shared `ChatMessageList` (the
 * native override, through the bundler alias) for one seeded session, placed
 * at the box the web client gives its transcript viewport so both shots crop
 * the same region. Everything around the box is the chat pane background.
 */

import { type NativeRenderer, render } from '@gpuix/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatMessageList } from '@/components/chat/ChatMessageList'
import { useAcpHistory } from '@/hooks/use-acp-history'
import { useAcpListeners } from '@/hooks/use-acp-listeners'
import { useAcpSessionResume } from '@/hooks/use-acp-session-resume'
import { useProjectRegistry } from '@/hooks/use-project-registry'
import { getAcpTransport } from '@/lib/acp-transport'
import { checkWebAuthGate } from '@/lib/web-auth-gate'
import { setWebAuthToken } from '@/lib/web-auth-token'
import { ensureClientIdentity } from '@/lib/web-client-identity'
import { useAcpStore } from '@/stores/acp-store'
import { transcriptProbe } from '../../../src/chat/perf-probe'
import { useSessionTimeline } from '../../../src/chat/use-session-timeline'
import type { ClientConfig } from '../../../src/client-config'
import { CompatRoot, compatRenderOptions } from '../../../src/compat/root'
import { log } from '../../../src/log'
import { tw } from '../../../src/style/tw'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import type { ControlIo, SceneBox, SceneOptions, ScenePerf, SceneTarget } from './contract'

/** ChatRoute's open: a live session is already known; a persisted one opens from history, retried while the index loads. */
function openExisting(sessionId: string): () => void {
  const started = performance.now()
  let cancelled = false
  let attempt = 0
  const tryOpen = async (): Promise<void> => {
    if (cancelled) return
    const existing = useAcpStore.getState().sessions[sessionId]
    if (existing && existing.status !== 'closed') return
    attempt++
    try {
      await useAcpStore.getState().openHistorySession(sessionId)
      log.info('chat-scene', `opened ${sessionId} in ${Math.round(performance.now() - started)} ms`)
    } catch (error) {
      if (attempt >= 10) log.warn('chat-scene', `open ${sessionId} failed: ${String(error)}`)
      else setTimeout(tryOpen, 500)
    }
  }
  setTimeout(tryOpen, 300)
  return () => {
    cancelled = true
  }
}

/** The launcher's start: the client spawns the agent and owns the live session, as a user's chat does. */
async function startChat(target: Extract<SceneTarget, { kind: 'start' }>): Promise<string> {
  const store = useAcpStore.getState()
  await store.loadAgentConfigs()
  const started = performance.now()
  const sessionId = await useAcpStore
    .getState()
    .startChat(target.configId, target.cwd, undefined, target.projectId)
  log.info('chat-scene', `started ${sessionId} in ${Math.round(performance.now() - started)} ms`)
  return sessionId
}

function useSceneSession(target: SceneTarget): string | null {
  const [started, setStarted] = useState<string | null>(null)
  useEffect(() => {
    if (target.kind === 'session') return openExisting(target.sessionId)
    let cancelled = false
    startChat(target).then(
      (id) => {
        if (!cancelled) setStarted(id)
      },
      (error: unknown) => log.warn('chat-scene', `start failed: ${String(error)}`)
    )
    return () => {
      cancelled = true
    }
  }, [target])
  return target.kind === 'session' ? target.sessionId : started
}

function Transcript({ sessionId, box }: { sessionId: string; box: SceneBox }) {
  const timeline = useSessionTimeline(sessionId)
  return (
    <div
      testId={timeline.items.length > 0 ? 'chat-scene-ready' : 'chat-scene-loading'}
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {timeline.showRunningIndicator ? (
        <div
          testId="chat-scene-turn-active"
          style={{ position: 'absolute', width: 1, height: 1 }}
        />
      ) : null}
      {timeline.items.length > 0 ? (
        <ChatMessageList
          items={timeline.items}
          sessionId={sessionId}
          showRunningIndicator={timeline.showRunningIndicator}
          filePathContext={timeline.filePathContext}
          onEditMessage={() => {}}
          onRetry={timeline.showRunningIndicator ? undefined : () => {}}
        />
      ) : null}
    </div>
  )
}

function Scene({
  options,
  renderer
}: {
  options: SceneOptions<NativeRenderer>
  renderer: NativeRenderer | null
}) {
  useProjectRegistry()
  useAcpListeners()
  useAcpHistory()
  useAcpSessionResume()
  const sessionId = useSceneSession(options.target)
  useSceneControl(renderer, options.control, sessionId, options.perfOut)
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
      {sessionId ? <Transcript sessionId={sessionId} box={options.box} /> : null}
    </div>
  )
}

interface TreeNode {
  id: number
  testId?: string
  children?: TreeNode[]
}

function findTestId(node: TreeNode, testId: string): TreeNode | null {
  if (node.testId === testId) return node
  for (const child of node.children ?? []) {
    const hit = findTestId(child, testId)
    if (hit) return hit
  }
  return null
}

/**
 * Harness control: `CHAT_CONTROL` names a JSON file the harness rewrites with
 * a `SceneCommand`. The automation protocol has no scroll call, so the scene
 * applies it with the renderer's own list scrolling.
 */
function useSceneControl(
  renderer: NativeRenderer | null,
  file: string | undefined,
  sessionId: string | null,
  perfOut: string | undefined
): void {
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  useEffect(() => {
    if (!renderer || !file) return
    const probe = perfOut ? startPerfProbe(renderer) : null
    let last = 0
    const timer = setInterval(() => {
      const raw = io.read(file)
      if (!raw || raw.seq <= last) return
      last = raw.seq
      if ('flushPerf' in raw) {
        if (probe && perfOut) io.write(perfOut, JSON.stringify(probe.perf))
        return
      }
      if ('prompt' in raw) {
        const sessionId = sessionRef.current
        if (!sessionId) return
        void useAcpStore
          .getState()
          .sendPrompt(sessionId, raw.prompt)
          .catch((error: unknown) => log.warn('chat-scene', `prompt failed: ${String(error)}`))
        return
      }
      if (!('getAutomationTree' in renderer) || typeof renderer.getAutomationTree !== 'function')
        return
      const tree = JSON.parse(renderer.getAutomationTree()) as TreeNode
      const list = findTestId(tree, 'chat-transcript-list')
      if (!list) return
      const count = list.children?.length ?? 0
      if (raw.scroll === 'bottom') renderer.scrollToItem?.(list.id, count)
      else if (raw.scroll === 'row') renderer.scrollToItem?.(list.id, raw.index, raw.offset)
      else {
        const index = (list.children ?? []).findIndex((row) => row.testId === `chat-row-${raw.key}`)
        if (index >= 0) renderer.scrollToItem?.(list.id, index, raw.offset)
      }
      log.info('chat-scene', `control ${JSON.stringify(raw)} rows=${count}`)
    }, 100)
    return () => {
      clearInterval(timer)
      probe?.stop()
    }
  }, [renderer, file, perfOut])
}

let io: ControlIo = { read: () => null, write: () => {} }

const MARKER = /mk(\d+)x/g

/**
 * Perf probe: frame events from GPUI's draw counter (polled every 1 ms, so a
 * frame's time is known to about a millisecond), and the commit time of each
 * storm chunk marker the transcript renders.
 */
function startPerfProbe(renderer: NativeRenderer): { perf: ScenePerf; stop(): void } {
  const perf: ScenePerf = { frames: [], commits: {} }
  const now = () => performance.timeOrigin + performance.now()
  transcriptProbe.onStreamCommit = (text) => {
    const t = now()
    for (const match of text.slice(-4000).matchAll(MARKER)) {
      const id = Number(match[1])
      if (perf.commits[id] === undefined) perf.commits[id] = t
    }
  }
  let last = renderer.getDebugFrameOverlayStats?.().frames ?? 0
  const timer = setInterval(() => {
    const stats = renderer.getDebugFrameOverlayStats?.()
    if (!stats || stats.frames === last) return
    last = stats.frames
    perf.frames.push({ t: now(), drawMs: stats.currentMs ?? 0 })
  }, 1)
  return {
    perf,
    stop: () => {
      clearInterval(timer)
      transcriptProbe.onStreamCommit = undefined
    }
  }
}

export function setControlIo(next: ControlIo): void {
  io = next
}

function SceneRoot({ options }: { options: SceneOptions<NativeRenderer> }) {
  const [renderer, setRenderer] = useState<NativeRenderer | null>(null)
  // CompatRoot rebinds on a new callback, so it must be stable.
  const onRenderer = useCallback(
    (r: NativeRenderer) => {
      options.onRenderer(r)
      setRenderer(r)
    },
    [options]
  )
  return (
    <CompatRoot onRenderer={onRenderer}>
      <Scene options={options} renderer={renderer} />
    </CompatRoot>
  )
}

export function boot(config: ClientConfig, options: SceneOptions<NativeRenderer>): void {
  if (config.token) setWebAuthToken(config.token)
  ensureClientIdentity()
  checkWebAuthGate()
  getAcpTransport()
    .connect()
    .catch((error: unknown) => log.warn('chat-scene', `ws connect failed: ${String(error)}`))
  render(<SceneRoot options={options} />, {
    title: 'Termul transcript',
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    focus: false,
    ...compatRenderOptions
  })
}
