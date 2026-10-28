import { SESSION_RPC_RESULTS, type SessionRpcResult } from '@shared/types/command-session'
import type { CompletionRpcReply, TerminalApi } from '@shared/types/ipc.types'
import type { WebTerminalReply } from '@shared/types/web-terminal-protocol.types'
import { logFrontendError } from './log-api'

export type WebCommandEditorRequestType =
  | 'command_editor_submit'
  | 'command_editor_request_completion'
  | 'command_editor_cancel_completion'
  | 'command_editor_restore_prompt'

export interface WebSessionRequestContext {
  socket: WebSocket
  id: string
  pending: Map<
    string,
    { timer: ReturnType<typeof setTimeout>; resolve: (reply: WebTerminalReply<unknown>) => void }
  >
  timeoutMs: number
}

interface WebCommandEditorClient {
  getSessionRequest: () => WebSessionRequestContext | null
}

type CommandEditorTransport = Pick<
  TerminalApi,
  'submitCommand' | 'requestCompletion' | 'cancelCompletion' | 'restorePrompt'
>

function isSessionRpcResult(value: unknown): value is SessionRpcResult {
  return SESSION_RPC_RESULTS.some((known) => known === value)
}

function readSessionRpcResult(value: unknown): SessionRpcResult | undefined {
  return isSessionRpcResult(value) ? value : undefined
}

function sessionRpcFallback(result: SessionRpcResult): SessionRpcResult {
  return result
}

function completionRpcFallback(result: SessionRpcResult): CompletionRpcReply {
  return { result }
}

function readCompletionRpcReply(value: unknown): CompletionRpcReply | undefined {
  if (isSessionRpcResult(value)) return { result: value }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const reply = value as Record<string, unknown>
  if (!isSessionRpcResult(reply.result)) return undefined
  const result = reply.result
  if (!('outcome' in reply) && !('completion' in reply)) return { result }
  if (reply.outcome === 'Completed') {
    if (
      !reply.completion ||
      typeof reply.completion !== 'object' ||
      Array.isArray(reply.completion)
    ) {
      return undefined
    }
    const { request_id, buffer_revision, cursor, prompt_generation, cwd, output } =
      reply.completion as Record<string, unknown>
    if (
      typeof request_id !== 'string' ||
      typeof buffer_revision !== 'number' ||
      !Number.isFinite(buffer_revision) ||
      typeof cursor !== 'number' ||
      !Number.isFinite(cursor) ||
      typeof prompt_generation !== 'number' ||
      !Number.isFinite(prompt_generation) ||
      typeof cwd !== 'string' ||
      typeof output !== 'string'
    )
      return undefined
    return {
      result,
      outcome: 'Completed',
      completion: { request_id, buffer_revision, cursor, prompt_generation, cwd, output }
    }
  }
  if (
    (reply.outcome === 'TimedOut' ||
      reply.outcome === 'Cancelled' ||
      reply.outcome === 'Dropped') &&
    !('completion' in reply)
  )
    return { result, outcome: reply.outcome }
  return undefined
}

function requestSession(
  client: WebCommandEditorClient,
  type: WebCommandEditorRequestType,
  payload: Record<string, unknown>
): Promise<WebTerminalReply<unknown>> | null {
  const context = client.getSessionRequest()
  if (!context) return null
  const { socket, id, pending, timeoutMs } = context
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({
        id,
        success: false,
        error: `Terminal request ${type} timed out`,
        code: 'NETWORK_ERROR'
      })
    }, timeoutMs)
    pending.set(id, { timer, resolve })
    try {
      socket.send(JSON.stringify({ id, type, payload }))
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      reject(error)
    }
  })
}

function createWebSend(client: WebCommandEditorClient) {
  return async function send<T>(
    type: WebCommandEditorRequestType,
    payload: Record<string, unknown>,
    read: (value: unknown) => T | undefined,
    fallback: (result: SessionRpcResult) => T
  ): Promise<T> {
    let failureResult: SessionRpcResult = 'PreWrite'
    try {
      const reply = await requestSession(client, type, payload)
      if (reply?.success) {
        const parsed = read(reply.data)
        if (parsed !== undefined) return parsed
        failureResult = 'Partial'
      } else if (reply?.code === 'NETWORK_ERROR') {
        // Sent without a reply: delivery is unknown and must not be retried.
        failureResult = 'Partial'
      }
    } catch {
      // The live send failed; session requests never enter the input queue.
    }
    void logFrontendError({
      level: 'warn',
      source: 'WebCommandEditorTransport',
      message: `session RPC failed: ${type}`
    })
    return fallback(failureResult)
  }
}

export function createWebCommandEditorTransport(
  client: WebCommandEditorClient
): CommandEditorTransport {
  const send = createWebSend(client)
  return {
    submitCommand: (terminalId, draft) =>
      send(
        'command_editor_submit',
        { terminalId, draft },
        readSessionRpcResult,
        sessionRpcFallback
      ),
    requestCompletion: (terminalId, request) =>
      send(
        'command_editor_request_completion',
        { ...request, terminalId },
        readCompletionRpcReply,
        completionRpcFallback
      ),
    cancelCompletion: (terminalId, requestId) =>
      send(
        'command_editor_cancel_completion',
        { terminalId, requestId },
        readSessionRpcResult,
        sessionRpcFallback
      ),
    restorePrompt: (terminalId) =>
      send(
        'command_editor_restore_prompt',
        { terminalId },
        readSessionRpcResult,
        sessionRpcFallback
      )
  }
}

function createTauriSend(
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
) {
  return async function send<T>(
    type: WebCommandEditorRequestType,
    args: Record<string, unknown>,
    read: (value: unknown) => T | undefined,
    fallback: (result: SessionRpcResult) => T
  ): Promise<T> {
    try {
      const result = await invoke(type, args)
      const parsed = read(result)
      if (parsed !== undefined) return parsed
    } catch {
      // Delivery is unknown; retrying could execute the command twice.
    }
    void logFrontendError({
      level: 'warn',
      source: 'TauriCommandEditorTransport',
      message: `session RPC failed: ${type}`
    })
    return fallback('Partial')
  }
}

export function createTauriCommandEditorTransport(
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
): CommandEditorTransport {
  const send = createTauriSend(invoke)
  return {
    submitCommand: (terminalId, draft) =>
      send(
        'command_editor_submit',
        { terminalId, draft },
        readSessionRpcResult,
        sessionRpcFallback
      ),
    requestCompletion: (terminalId, request) =>
      send(
        'command_editor_request_completion',
        { terminalId, request },
        readCompletionRpcReply,
        completionRpcFallback
      ),
    cancelCompletion: (terminalId, requestId) =>
      send(
        'command_editor_cancel_completion',
        { terminalId, requestId },
        readSessionRpcResult,
        sessionRpcFallback
      ),
    restorePrompt: (terminalId) =>
      send(
        'command_editor_restore_prompt',
        { terminalId },
        readSessionRpcResult,
        sessionRpcFallback
      )
  }
}
