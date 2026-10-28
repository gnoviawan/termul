import type { CompletionReplyFields, TerminalApi } from '@shared/types/ipc.types'
import { useEffect, useMemo, useRef } from 'react'
import { useAddCommand } from '@/hooks/use-command-history'
import { logFrontendError } from '@/lib/log-api'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { type CompletionContext, CompletionScheduler, type SchedulerClock } from './completion'
import { commandDraftStore } from './draft-store'
import { type SubmitToken, sessionStore } from './session-store'
import {
  type AddCommandFn,
  handleAcceptedSubmit,
  type SubmitDraftResult,
  type SubmitLogEvent,
  submitDraft
} from './submit'
import type { InputMode, SessionPhase } from './transition'

let nextRequestId = 0

export type BindSessionHost = Pick<TerminalApi, 'submitCommand'> &
  Partial<Pick<TerminalApi, 'requestCompletion' | 'cancelCompletion' | 'restorePrompt' | 'write'>>

export interface BindSessionClientArgs {
  host: BindSessionHost
  scheduler?: CompletionScheduler
  terminalId: string
  ptyId: () => string | null
  terminalName?: string
  projectId?: string
  addCommand?: AddCommandFn
  log?: (event: SubmitLogEvent) => void
  term?: { write: (data: string) => void }
  clock?: SchedulerClock
  createRequestId?: () => string
}

export interface SessionCompletionInput {
  terminalId?: string
  sessionId?: string
  mode?: InputMode
  phase?: SessionPhase
  draft: string
  bufferRevision?: number
  revision?: number
  cursor: number
  promptGeneration?: number
  cwd?: string
}

export interface BoundSessionClient {
  submit: (draft: string) => Promise<SubmitDraftResult>
  scheduler: CompletionScheduler
  activate: () => void
  dispose: () => void
  completion: () => CompletionReplyFields | null
  subscribeCompletion: (listener: () => void) => () => void
  updateContext: (context: SessionCompletionInput) => void
  requestCompletion: (context: SessionCompletionInput, showing?: boolean) => void
}

function wrapSessionHost(host: BindSessionHost, ptyId: () => string | null): BindSessionHost {
  return {
    submitCommand: async (_terminalId, draft) => {
      const pty = ptyId()
      if (pty == null) return 'NotStarted'
      return host.submitCommand(pty, draft)
    },
    requestCompletion: async (_terminalId, request) => {
      const pty = ptyId()
      if (pty == null || !host.requestCompletion) return { result: 'NotStarted' }
      return host.requestCompletion(pty, request)
    },
    cancelCompletion: async (_terminalId, requestId) => {
      const pty = ptyId()
      if (pty == null || !host.cancelCompletion) return 'NotStarted'
      return host.cancelCompletion(pty, requestId)
    },
    restorePrompt: async (_terminalId) => {
      const pty = ptyId()
      if (pty == null || !host.restorePrompt) return 'NotStarted'
      return host.restorePrompt(pty)
    }
  }
}

function skippedSubmit(draft: string): SubmitDraftResult {
  void logFrontendError({
    level: 'info',
    source: 'bindSessionClient',
    message: 'submit skipped: pty id is null'
  })
  return { result: 'NotStarted', committedSubmit: false, draft, editorMounted: true }
}

function sessionScheduler(
  args: BindSessionClientArgs,
  host: BindSessionHost,
  onResult: (completion: CompletionReplyFields) => void
): CompletionScheduler {
  return (
    args.scheduler ??
    new CompletionScheduler({
      host: {
        requestCompletion: (terminalId, request) =>
          host.requestCompletion?.(terminalId, request) ??
          Promise.resolve({ result: 'NotStarted' }),
        cancelCompletion: (terminalId, requestId) =>
          host.cancelCompletion?.(terminalId, requestId) ?? Promise.resolve('NotStarted')
      },
      createRequestId: args.createRequestId ?? (() => `completion-${++nextRequestId}`),
      settings: {
        automaticCompletionRefresh:
          useAppSettingsStore.getState().settings.automaticCompletionRefresh !== false
      },
      clock: args.clock,
      onResult,
      log: (event) => {
        void logFrontendError({
          level: 'info',
          source: 'CompletionScheduler',
          message: `${event.name} ${event.detail}`
        })
      }
    })
  )
}

function resolveCompletionContext(
  terminalId: string,
  input: SessionCompletionInput
): CompletionContext | null {
  const session = sessionStore.read(terminalId)
  if (
    !session.registered ||
    !session.alive ||
    !session.trusted ||
    session.mode !== 'Editor' ||
    session.phase !== 'AtPrompt' ||
    !session.sessionId ||
    session.promptGeneration === null ||
    !session.cwd
  )
    return null
  return {
    terminalId,
    sessionId: session.sessionId,
    mode: session.mode,
    phase: session.phase,
    draft: input.draft,
    bufferRevision: input.bufferRevision ?? input.revision ?? 0,
    cursor: input.cursor,
    promptGeneration: session.promptGeneration,
    cwd: session.cwd
  }
}

function watchCompletionSession(terminalId: string, invalidate: () => void) {
  let unsubscribe: (() => void) | null = null
  let previous = sessionStore.read(terminalId)
  const activate = () => {
    if (unsubscribe) return
    previous = sessionStore.read(terminalId)
    unsubscribe = sessionStore.subscribe(() => {
      const current = sessionStore.read(terminalId)
      if (
        current.mode !== 'Editor' ||
        current.sessionId !== previous.sessionId ||
        current.nonce !== previous.nonce ||
        current.promptGeneration !== previous.promptGeneration
      )
        invalidate()
      previous = current
    })
  }
  activate()
  return {
    activate,
    dispose: () => {
      unsubscribe?.()
      unsubscribe = null
      invalidate()
    }
  }
}

function bindCompletion(args: BindSessionClientArgs, host: BindSessionHost) {
  let completion: CompletionReplyFields | null = null
  const listeners = new Set<() => void>()
  const scheduler = sessionScheduler(args, host, (result) => {
    completion = result
    for (const listener of listeners) listener()
  })
  const invalidate = () => {
    completion = null
    scheduler.invalidate()
  }
  const lifecycle = watchCompletionSession(args.terminalId, invalidate)
  const updateContext = (input: SessionCompletionInput): void => {
    completion = null
    const context = resolveCompletionContext(args.terminalId, input)
    if (context) scheduler.updateContext(context)
    else invalidate()
  }
  const requestCompletion = (input: SessionCompletionInput, showing?: boolean): void => {
    const context = resolveCompletionContext(args.terminalId, input)
    if (context) scheduler.requestCompletion(context, showing)
    else invalidate()
  }
  return {
    scheduler,
    ...lifecycle,
    updateContext,
    requestCompletion,
    completion: () => completion,
    subscribeCompletion: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

function transactionHost(
  args: BindSessionClientArgs,
  ptyId: string,
  token: SubmitToken
): BindSessionHost {
  return {
    submitCommand: (_terminalId, draft) =>
      sessionStore.isSubmitCurrent(args.terminalId, token)
        ? args.host.submitCommand(ptyId, draft)
        : Promise.resolve('NotStarted')
  }
}

async function submitBoundDraft(
  args: BindSessionClientArgs,
  scheduler: CompletionScheduler,
  draft: string
): Promise<SubmitDraftResult> {
  const ptyId = args.ptyId()
  if (ptyId == null) return skippedSubmit(draft)
  const token = sessionStore.beginSubmit(args.terminalId)
  if (!token) return skippedSubmit(draft)
  const outcome = await submitDraft({
    host: transactionHost(args, ptyId, token),
    scheduler,
    terminalId: args.terminalId,
    terminalName: args.terminalName ?? 'terminal',
    projectId: args.projectId ?? 'default',
    draft,
    addCommand: args.addCommand,
    log: args.log,
    onReply: (result) => {
      if (!sessionStore.recordSubmit(args.terminalId, result, token)) return false
      if (result === 'Accepted' || result === 'Partial') {
        commandDraftStore.submitAccepted(args.terminalId)
      }
      return true
    }
  })
  if (outcome.result === 'Accepted') {
    handleAcceptedSubmit({ command: draft, term: args.term })
  }
  return outcome
}

export function bindSessionClient(args: BindSessionClientArgs): BoundSessionClient {
  const host = wrapSessionHost(args.host, args.ptyId)
  const completion = bindCompletion(args, host)
  return {
    ...completion,
    submit: (draft) => submitBoundDraft(args, completion.scheduler, draft)
  }
}

export function useBindSessionClient(
  args: Omit<BindSessionClientArgs, 'addCommand'>
): BoundSessionClient {
  const addCommand = useAddCommand()
  const latest = useRef({ ...args, addCommand })
  latest.current = { ...args, addCommand }
  const terminalId = args.terminalId
  const binder = useMemo(
    () =>
      bindSessionClient({
        ...latest.current,
        terminalId,
        get host() {
          return latest.current.host
        },
        ptyId: () => latest.current.ptyId(),
        get terminalName() {
          return latest.current.terminalName
        },
        get projectId() {
          return latest.current.projectId
        },
        addCommand: (...params) => latest.current.addCommand(...params)
      }),
    [terminalId]
  )
  useEffect(() => {
    binder.activate()
    return () => binder.dispose()
  }, [binder])
  return binder
}
