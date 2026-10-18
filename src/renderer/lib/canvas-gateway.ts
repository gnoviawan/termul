/**
 * Connects the canvas store to the host gateway (spine AD-21, AD-29): every
 * canvas this renderer has mounted (loading or ready) is reported to the host
 * as held by this connection, and the agent calls the host forwards run
 * through that mount's bridge. Calls made while the editor is still loading
 * wait in the bridge's queue; the host times them out, never this side.
 *
 * `host.save` is the one call answered here instead of in the editor: the
 * agent's `save_file` is Termul's save of the project's document (AD-18,
 * AD-23), and it answers with the document's project-relative path.
 */

import { type AcpTransport, getAcpTransport } from '@/lib/acp-transport'
import {
  answerGatewayCall,
  asJsonText,
  bridgeFailure,
  type CanvasBridgeReply
} from '@/lib/canvas-bridge'
import { type CanvasSession, useCanvasStore } from '@/stores/canvas-store'
import { useProjectStore } from '@/stores/project-store'

const HOST_SAVE = 'host.save'

function mountedSeqOf(session: CanvasSession | undefined): number | null {
  const phase = session?.phase
  return phase?.kind === 'loading' || phase?.kind === 'ready' ? phase.mount.mountSeq : null
}

/** `docPath` relative to `root` with forward slashes; the absolute path when
 * the document is not under the root. Drive-letter roots compare
 * case-insensitively, as Windows paths do. */
export function projectRelativePath(docPath: string, root: string | undefined): string {
  const doc = docPath.replace(/\\/g, '/')
  if (!root) return doc
  const prefix = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  const fold = (path: string): string => (/^[A-Za-z]:/.test(path) ? path.toLowerCase() : path)
  return fold(doc).startsWith(fold(prefix)) ? doc.slice(prefix.length) : doc
}

async function hostSave(projectId: string): Promise<CanvasBridgeReply> {
  const canvas = useCanvasStore.getState()
  const session = canvas.sessions[projectId]
  if (session?.phase.kind !== 'ready') {
    return bridgeFailure('CANVAS_CLOSED', 'the canvas document is not loaded')
  }
  try {
    if (!(await canvas.saveCanvas(projectId))) {
      const saveError = useCanvasStore.getState().sessions[projectId]?.saveError
      return bridgeFailure('ENGINE_ERROR', saveError ?? 'the canvas could not be saved')
    }
  } catch (error) {
    return bridgeFailure('ENGINE_ERROR', error instanceof Error ? error.message : String(error))
  }
  const root = useProjectStore.getState().projects.find((p) => p.id === projectId)?.path
  const path = projectRelativePath(session.docPath, root)
  return { ok: true, result: asJsonText(JSON.stringify({ path })) }
}

/** Start serving gateway calls from this renderer's canvases. Returns the stop. */
export function startCanvasGateway(transport: AcpTransport = getAcpTransport()): () => void {
  const gateway = transport.canvas
  if (!gateway) return () => {}
  const store = useCanvasStore.getState

  gateway.setCallHandler((call) =>
    answerGatewayCall(call, mountedSeqOf(store().sessions[call.projectId]), (method, params) =>
      method === HOST_SAVE
        ? hostSave(call.projectId)
        : store().callCanvas(call.projectId, method, params)
    )
  )

  const reported = new Set<string>()
  const sync = (sessions: Record<string, CanvasSession>): void => {
    for (const projectId of reported) {
      if (mountedSeqOf(sessions[projectId]) === null) {
        gateway.setMount(projectId, null)
        reported.delete(projectId)
      }
    }
    for (const [projectId, session] of Object.entries(sessions)) {
      const mountSeq = mountedSeqOf(session)
      if (mountSeq === null) continue
      gateway.setMount(projectId, mountSeq)
      reported.add(projectId)
    }
  }
  sync(store().sessions)
  const unsubscribe = useCanvasStore.subscribe((state) => sync(state.sessions))

  return () => {
    unsubscribe()
    gateway.setCallHandler(null)
    for (const projectId of reported) gateway.setMount(projectId, null)
    reported.clear()
  }
}
