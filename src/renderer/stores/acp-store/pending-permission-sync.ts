/**
 * Issue #1595: install the host's still-pending approvals, questions and
 * elicitations of a session after a (re)subscribe. A `permission_request` is
 * not in the durable log, and a replayed question or elicitation below the
 * history watermark is dropped as history, so a client that reconnects or
 * reopens mid-turn would otherwise never render the prompt again while the
 * turn waits on it.
 *
 * Each host list is authoritative for its kind and session: a listed request
 * missing from the store is added, and a stored one the host no longer lists
 * (answered from another client, or released) is dropped. A kind the reply
 * carried no list for is left alone.
 */

import type { SessionId } from '@/lib/acp-api'
import type { PendingPromptKind, PendingPrompts } from '@/lib/acp-transport/pending-permissions'
import { logFrontendError } from '@/lib/log-api'
import type { AcpState } from './types'

/**
 * Per kind, the ids whose answer is on its way to the host. The store drops a
 * request optimistically when it is answered; a pending list taken before the
 * host processed that answer must not bring it back.
 */
const answering: Record<PendingPromptKind, Set<string>> = {
  permissions: new Set(),
  questions: new Set(),
  elicitations: new Set()
}

export function noteAnswering(kind: PendingPromptKind, id: string): void {
  answering[kind].add(id)
}

export function forgetAnswering(kind: PendingPromptKind, id: string): void {
  answering[kind].delete(id)
}

type StoreGet = () => AcpState
type StoreSet = (fn: (state: AcpState) => Partial<AcpState>) => void

const STORE_KEY = {
  permissions: 'pendingPermissions',
  questions: 'pendingQuestions',
  elicitations: 'pendingElicitations'
} as const satisfies Record<PendingPromptKind, keyof AcpState>

/** Drop the session's stored requests of `kind` whose ids the host list leaves out. */
function dropUnlisted(
  set: StoreSet,
  sessionId: SessionId,
  kind: PendingPromptKind,
  listed: ReadonlySet<string>
): void {
  const key = STORE_KEY[kind]
  let dropped = 0
  set((state) => {
    const stored: Record<string, { sessionId: string }> = state[key] ?? {}
    const stale = Object.keys(stored).filter(
      (id) => stored[id].sessionId === sessionId && !listed.has(id)
    )
    if (stale.length === 0) return {}
    dropped = stale.length
    const next = { ...stored }
    for (const id of stale) delete next[id]
    return { [key]: next }
  })
  if (dropped > 0) {
    void logFrontendError({
      level: 'info',
      source: 'acp.pendingPrompts',
      message: `Session ${sessionId} dropped ${dropped} pending ${kind} the host no longer holds`
    })
  }
}

function syncKind<T>(
  set: StoreSet,
  sessionId: SessionId,
  kind: PendingPromptKind,
  requests: readonly T[],
  idOf: (request: T) => string,
  install: (request: T) => void
): void {
  dropUnlisted(set, sessionId, kind, new Set(requests.map(idOf)))
  for (const request of requests) {
    if (answering[kind].has(idOf(request))) continue
    // No event seq: the host list is current, so the history watermark must
    // not read it as already covered. An existing entry is kept as is.
    install(request)
  }
}

export function syncPendingPrompts(
  get: StoreGet,
  set: StoreSet,
  sessionId: SessionId,
  prompts: PendingPrompts
): void {
  if (prompts.permissions) {
    syncKind(
      set,
      sessionId,
      'permissions',
      prompts.permissions,
      (request) => request.requestId,
      (request) => get()._onPermissionRequest(request)
    )
  }
  if (prompts.questions) {
    syncKind(
      set,
      sessionId,
      'questions',
      prompts.questions,
      (request) => request.questionId,
      (request) => get()._onQuestionRequest(request)
    )
  }
  if (prompts.elicitations) {
    syncKind(
      set,
      sessionId,
      'elicitations',
      prompts.elicitations,
      (request) => request.requestId,
      (request) => get()._onElicitationRequest(request)
    )
  }
}
