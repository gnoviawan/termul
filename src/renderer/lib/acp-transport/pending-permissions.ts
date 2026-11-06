import type {
  AskUserQuestionEvent,
  ElicitationRequestEvent,
  PermissionRequestEvent
} from '@/lib/acp-api'

/**
 * The host's still-pending prompts of one session, from a `subscribe` or
 * `recover_session_snapshot` reply. Each list is authoritative for its kind: a
 * prompt of the session that is not in it was answered or released. `null`
 * means the host sent no list of that kind (a host without those tickets, or
 * one that predates them), so the client keeps what it has.
 */
export interface PendingPrompts {
  permissions: PermissionRequestEvent[] | null
  questions: AskUserQuestionEvent[] | null
  elicitations: ElicitationRequestEvent[] | null
}

export type PendingPromptKind = keyof PendingPrompts

export type PendingPromptsHandler = (sessionId: string, prompts: PendingPrompts) => void

/** The request event each kind's list holds, by wire event type. */
const KIND_OF_EVENT = new Map<string, PendingPromptKind>([
  ['permission_request', 'permissions'],
  ['question_request', 'questions'],
  ['elicitation_request', 'elicitations']
])

type Fields = Record<string, unknown>

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function ofSession(value: unknown, sessionId: string): value is Fields {
  if (!value || typeof value !== 'object') return false
  const fields = value as Fields
  return fields.sessionId === sessionId && typeof fields.agentId === 'string'
}

function isPermissionRequest(value: unknown, sessionId: string): value is PermissionRequestEvent {
  return ofSession(value, sessionId) && isId(value.requestId) && Array.isArray(value.options)
}

function isQuestionRequest(value: unknown, sessionId: string): value is AskUserQuestionEvent {
  return (
    ofSession(value, sessionId) &&
    isId(value.questionId) &&
    typeof value.question === 'string' &&
    Array.isArray(value.options)
  )
}

function isElicitationRequest(value: unknown, sessionId: string): value is ElicitationRequestEvent {
  return (
    ofSession(value, sessionId) &&
    isId(value.requestId) &&
    typeof value.mode === 'string' &&
    typeof value.message === 'string' &&
    Array.isArray(value.fields)
  )
}

function readList<T>(
  reply: unknown,
  key: string,
  sessionId: string,
  isRequest: (value: unknown, sessionId: string) => value is T
): T[] | null {
  if (!reply || typeof reply !== 'object') return null
  const list = (reply as Fields)[key]
  if (!Array.isArray(list)) return null
  return list.filter((value): value is T => isRequest(value, sessionId))
}

/**
 * The reply's `pendingPermissions`, `pendingQuestions` and
 * `pendingElicitations` for `sessionId`. An absent key reads as `null`;
 * malformed entries and entries of another session are skipped.
 */
export function readPendingPrompts(sessionId: string, reply: unknown): PendingPrompts {
  return {
    permissions: readList(reply, 'pendingPermissions', sessionId, isPermissionRequest),
    questions: readList(reply, 'pendingQuestions', sessionId, isQuestionRequest),
    elicitations: readList(reply, 'pendingElicitations', sessionId, isElicitationRequest)
  }
}

/** Counts of the non-empty lists for a log line (`1 permissions, 2 elicitations`), or `''`. */
export function pendingPromptCounts(prompts: PendingPrompts): string {
  return Object.entries(prompts)
    .filter(([, list]) => list && list.length > 0)
    .map(([kind, list]) => `${list?.length} ${kind}`)
    .join(', ')
}

/**
 * Host consent tickets (`host:<uuid>`, `HOST_TICKET_PREFIX` in
 * `browser-consent-api.ts`, which imports this transport) ride
 * `permission_request` too but are never in the pending list.
 */
const HOST_TICKET_PREFIX = 'host:'

function isHostTicket(payload: unknown): boolean {
  const requestId = (payload as { requestId?: unknown } | null)?.requestId
  return typeof requestId === 'string' && requestId.startsWith(HOST_TICKET_PREFIX)
}

/** A replayed question/elicitation's id, which the list names while it is still pending. */
function promptId(kind: PendingPromptKind, payload: unknown): unknown {
  const fields = (payload ?? {}) as Fields
  return kind === 'questions' ? fields.questionId : fields.requestId
}

/** The ids a list holds, for the kinds whose replay is still delivered when listed. */
function listedIds(kind: PendingPromptKind, prompts: PendingPrompts): Set<unknown> | undefined {
  if (kind === 'questions') return new Set(prompts.questions?.map((q) => q.questionId))
  if (kind === 'elicitations') return new Set(prompts.elicitations?.map((e) => e.requestId))
  return undefined
}

/**
 * Per session and kind, the log head an authoritative pending list was taken
 * at. A request event of that kind at or below it is replay the list already
 * settled. An approval is always dropped (the list restored it if pending). A
 * question or elicitation is dropped only when the list leaves it out (it was
 * answered); a listed one still flows through replay so listeners such as
 * chat notifications see it. Events above the head are live and always
 * delivered.
 */
export class PendingPromptCoverage {
  private readonly heads = new Map<
    string,
    Map<PendingPromptKind, { head: number; listed?: Set<unknown> }>
  >()

  /** Record a reply: each listed kind's head covers replay; an unlisted kind is not covered. */
  note(sessionId: string, headSeq: number | undefined, prompts: PendingPrompts): void {
    const heads = new Map<PendingPromptKind, { head: number; listed?: Set<unknown> }>()
    if (typeof headSeq === 'number') {
      for (const kind of KIND_OF_EVENT.values()) {
        if (prompts[kind] !== null)
          heads.set(kind, { head: headSeq, listed: listedIds(kind, prompts) })
      }
    }
    if (heads.size > 0) this.heads.set(sessionId, heads)
    else this.heads.delete(sessionId)
  }

  covers(sessionId: string, evt: { type: string; seq: number; payload?: unknown }): boolean {
    const kind = KIND_OF_EVENT.get(evt.type)
    if (!kind) return false
    if (kind === 'permissions' && isHostTicket(evt.payload)) return false
    const coverage = this.heads.get(sessionId)?.get(kind)
    if (!coverage || evt.seq > coverage.head) return false
    return !coverage.listed?.has(promptId(kind, evt.payload))
  }

  forget(sessionId: string): void {
    this.heads.delete(sessionId)
  }
}
