/**
 * GPUIX side of the transcript scene: the shared `ChatMessageList` (the
 * native override, through the bundler alias) for one seeded session, placed
 * at the box the web client gives its transcript viewport so both shots crop
 * the same region. Everything around the box is the chat pane background.
 */

import { type NativeRenderer, render } from '@gpuix/react'
import { useCallback, useEffect, useState } from 'react'
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
import type { ClientConfig } from '../../../src/client-config'
import type { SceneBox, SceneCommand, SceneOptions } from './contract'
import { useSessionTimeline } from '../../../src/chat/use-session-timeline'
import { CompatRoot, compatRenderOptions } from '../../../src/compat/root'
import { log } from '../../../src/log'
import { tw } from '../../../src/style/tw'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'


function Transcript({ sessionId, box }: { sessionId: string; box: SceneBox }) {
  useProjectRegistry()
  useAcpListeners()
  useAcpHistory()
  useAcpSessionResume()
  // ChatRoute's open: a live session is already known from the socket; a
  // persisted one opens from history, retried while the index loads.
  useEffect(() => {
    const started = performance.now()
    let cancelled = false
    let attempt = 0
    const tryOpen = async (): Promise<void> => {
      if (cancelled) return
      const existing = useAcpStore.getState().sessions[sessionId]
      if (existing && existing.status !== 'closed') {
        log.info('chat-scene', `live ${sessionId} after ${Math.round(performance.now() - started)} ms`)
        return
      }
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
  }, [sessionId])
  const timeline = useSessionTimeline(sessionId)
  return (
    <div style={{ ...tw('bg-terminal-bg'), position: 'absolute', left: 0, top: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT }}>
      <div
        testId={timeline.items.length > 0 ? 'chat-scene-ready' : 'chat-scene-loading'}
        style={{ position: 'absolute', left: box.x, top: box.y, width: box.width, height: box.height, display: 'flex', flexDirection: 'column' }}
      >
        {timeline.items.length > 0 ? (
          <ChatMessageList
            items={timeline.items}
            sessionId={sessionId}
            showRunningIndicator={timeline.showRunningIndicator}
            filePathContext={timeline.filePathContext}
          />
        ) : null}
      </div>
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
function useSceneControl(renderer: NativeRenderer | null, file: string | undefined): void {
  useEffect(() => {
    if (!renderer || !file) return
    let last = 0
    const timer = setInterval(() => {
      const raw = readControl(file)
      if (!raw || raw.seq <= last) return
      last = raw.seq
      if (!('getAutomationTree' in renderer) || typeof renderer.getAutomationTree !== 'function') return
      const tree = JSON.parse(renderer.getAutomationTree()) as TreeNode
      const list = findTestId(tree, 'chat-transcript-list')
      if (!list) return
      const count = list.children?.length ?? 0
      if (raw.scroll === 'bottom') renderer.scrollToItem?.(list.id, count)
      else renderer.scrollToItem?.(list.id, raw.index, raw.offset)
      log.info('chat-scene', `control ${JSON.stringify(raw)} rows=${count}`)
    }, 100)
    return () => clearInterval(timer)
  }, [renderer, file])
}

let readControl: (file: string) => SceneCommand | null = () => null

/** The harness side passes a reader so this app-side file stays free of node:fs types. */
export function setControlReader(reader: (file: string) => SceneCommand | null): void {
  readControl = reader
}

function SceneRoot({ options }: { options: SceneOptions<NativeRenderer> }) {
  const [renderer, setRenderer] = useState<NativeRenderer | null>(null)
  useSceneControl(renderer, options.control)
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
      <Transcript sessionId={options.sessionId} box={options.box} />
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
  render(<SceneRoot options={options} />,
    {
      title: 'Termul transcript',
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      focus: false,
      ...compatRenderOptions
    }
  )
}
