import type {
  CompletionReplyFields,
  CompletionRpcReply,
  TerminalApi
} from '@shared/types/ipc.types'
import type { AppSettings } from '@/types/settings'
import type { InputMode, SessionPhase } from './transition'

/** Host completion timeout (1500) + host drain bound (2000) + 500ms margin. */
export const CLIENT_COMPLETION_TIMEOUT_MS = 1500 + 2000 + 500

const IDLE_WINDOW_MS = 100

export type CompletionHost = Pick<TerminalApi, 'requestCompletion' | 'cancelCompletion'>

export interface SchedulerClock {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

export interface CompletionContext {
  terminalId: string
  sessionId: string
  mode: InputMode
  phase: SessionPhase
  draft: string
  bufferRevision: number
  cursor: number
  promptGeneration: number
  cwd?: string
}

export interface CompletionLogEvent {
  name: string
  detail: string
}

export interface CompletionSchedulerDeps {
  host: CompletionHost
  createRequestId: () => string
  settings: Pick<AppSettings, 'automaticCompletionRefresh'>
  clock?: SchedulerClock
  log?: (event: CompletionLogEvent) => void
  onResult?: (completion: CompletionReplyFields) => void
}

interface InFlight {
  requestId: string
  context: CompletionContext
}

function contextMatches(left: CompletionContext, right: CompletionContext): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.mode === right.mode &&
    left.draft === right.draft &&
    left.bufferRevision === right.bufferRevision &&
    left.cursor === right.cursor &&
    left.promptGeneration === right.promptGeneration &&
    left.cwd === right.cwd
  )
}

function completionSkipReason(
  draft: string,
  cursor: number
): 'inside_quote' | 'inside_word' | null {
  if (isInsideOpenQuote(draft, cursor)) return 'inside_quote'
  const next = draft[cursor]
  if (next !== undefined && !/\s/.test(next)) return 'inside_word'
  return null
}

function isInsideOpenQuote(draft: string, cursor: number): boolean {
  let inSingle = false
  let inDouble = false
  const point = Math.max(0, Math.min(cursor, draft.length))
  for (let i = 0; i < point; i++) {
    const ch = draft[i]
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") inSingle = true
    else if (ch === '"') inDouble = true
  }
  return inSingle || inDouble
}

function completionFieldsMatch(active: InFlight, completion: CompletionReplyFields): boolean {
  return (
    completion.request_id === active.requestId &&
    completion.buffer_revision === active.context.bufferRevision &&
    completion.cursor === active.context.cursor &&
    completion.prompt_generation === active.context.promptGeneration &&
    completion.cwd === active.context.cwd
  )
}

const defaultClock: SchedulerClock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (id) => {
    clearTimeout(id as ReturnType<typeof setTimeout>)
  }
}

export class CompletionScheduler {
  private readonly host: CompletionHost
  private readonly createRequestId: () => string
  private readonly autoRefreshEnabled: () => boolean
  private readonly clock: SchedulerClock
  private readonly log?: (event: CompletionLogEvent) => void
  private readonly onResult?: (completion: CompletionReplyFields) => void
  private inFlight: InFlight | null = null
  private latest: CompletionContext | null = null
  private replacement: CompletionContext | null = null
  private idleTimer: unknown = null
  private clientTimer: unknown = null
  private cancellation: Promise<unknown> | null = null

  constructor(deps: CompletionSchedulerDeps) {
    this.host = deps.host
    this.createRequestId = deps.createRequestId
    const settings = deps.settings
    this.autoRefreshEnabled = () => settings.automaticCompletionRefresh !== false
    this.clock = deps.clock ?? defaultClock
    this.log = deps.log
    this.onResult = deps.onResult
  }

  get inFlightRequestId(): string | null {
    return this.inFlight?.requestId ?? null
  }

  requestCompletion(context: CompletionContext, showing = false): void {
    this.latest = context
    if (showing) return
    if (this.inFlight) {
      this.log?.({
        name: 'completion_tab_ignored',
        detail: `requestId=${this.inFlight.requestId}`
      })
      return
    }
    this.startRequest(context)
  }

  updateContext(context: CompletionContext): void {
    this.latest = context
    if (this.inFlight) {
      this.invalidateIfChanged(context)
      return
    }
    this.armIdle()
  }

  async prepareSubmit(): Promise<string | null> {
    this.clearIdle()
    this.replacement = null
    const active = this.inFlight
    this.inFlight = null
    this.clearClientTimeout()
    if (!active) {
      await this.cancellation
      return null
    }
    this.log?.({
      name: 'completion_cancelled',
      detail: `requestId=${active.requestId} reason=submit`
    })
    await this.host.cancelCompletion(active.context.terminalId, active.requestId)
    return active.requestId
  }

  invalidate(): void {
    this.clearIdle()
    this.clearClientTimeout()
    this.latest = null
    this.replacement = null
    const active = this.inFlight
    this.inFlight = null
    if (active) {
      this.cancellation = this.host
        .cancelCompletion(active.context.terminalId, active.requestId)
        .catch(() => {
          this.log?.({ name: 'completion_cancel_failed', detail: 'reason=invalidate' })
        })
    }
  }

  private invalidateIfChanged(context: CompletionContext): void {
    if (!this.inFlight || contextMatches(this.inFlight.context, context)) return
    this.log?.({
      name: 'completion_invalidated',
      detail: `requestId=${this.inFlight.requestId}`
    })
    if (this.autoRefreshEnabled()) this.replacement = context
  }

  private armIdle(): void {
    if (!this.autoRefreshEnabled()) return
    this.clearIdle()
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null
      if (this.inFlight || !this.latest) return
      this.startRequest(this.latest, true)
    }, IDLE_WINDOW_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer == null) return
    this.clock.clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private startRequest(context: CompletionContext, automatic = false): void {
    this.clearIdle()
    if (automatic && !this.autoRefreshEnabled()) return
    if (!context.cwd) {
      this.log?.({
        name: 'completion_skipped',
        detail: 'reason=missing_cwd'
      })
      return
    }
    if (automatic && context.draft.trim() === '') {
      this.log?.({
        name: 'completion_skipped',
        detail: 'reason=blank_draft'
      })
      return
    }
    const skip = completionSkipReason(context.draft, context.cursor)
    if (skip) {
      this.log?.({
        name: 'completion_skipped',
        detail: `reason=${skip}`
      })
      return
    }
    const requestId = this.createRequestId()
    this.inFlight = { requestId, context }
    this.log?.({
      name: 'completion_requested',
      detail: `requestId=${requestId} revision=${context.bufferRevision} cursor=${context.cursor}`
    })
    this.armClientTimeout(requestId, context.terminalId)
    void this.host
      .requestCompletion(context.terminalId, {
        requestId,
        draft: context.draft,
        bufferRevision: context.bufferRevision,
        cursor: context.cursor,
        promptGeneration: context.promptGeneration,
        cwd: context.cwd
      })
      .then((reply) => this.handleReply(requestId, reply))
  }

  private armClientTimeout(requestId: string, terminalId: string): void {
    this.clearClientTimeout()
    this.clientTimer = this.clock.setTimeout(() => {
      this.onClientTimeout(requestId, terminalId)
    }, CLIENT_COMPLETION_TIMEOUT_MS)
  }

  private onClientTimeout(requestId: string, terminalId: string): void {
    this.clientTimer = null
    if (!this.inFlight || this.inFlight.requestId !== requestId) return
    this.inFlight = null
    this.log?.({ name: 'completion_timeout', detail: 'result=Partial' })
    void this.host.cancelCompletion(terminalId, requestId)
    this.startReplacement()
  }

  private clearClientTimeout(): void {
    if (this.clientTimer == null) return
    this.clock.clearTimeout(this.clientTimer)
    this.clientTimer = null
  }

  private handleReply(requestId: string, reply: CompletionRpcReply): void {
    const active = this.inFlight
    if (!active || active.requestId !== requestId) {
      return
    }
    this.clearClientTimeout()
    this.inFlight = null
    if (this.isMatchingResult(active, reply) && reply.completion) this.onResult?.(reply.completion)
    if (reply.result === 'NotStarted') {
      this.replacement = null
      return
    }
    this.startReplacement()
  }

  private isMatchingResult(active: InFlight, reply: CompletionRpcReply): boolean {
    return (
      this.latest !== null &&
      contextMatches(active.context, this.latest) &&
      reply.completion !== undefined &&
      completionFieldsMatch(active, reply.completion)
    )
  }

  private startReplacement(): void {
    const next = this.replacement
    this.replacement = null
    if (next) this.startRequest(this.latest ?? next, true)
  }
}
