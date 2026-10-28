import type { SessionRpcResult } from '@shared/types/command-session'
import type { TerminalApi } from '@shared/types/ipc.types'
import type { CompletionScheduler } from './completion'

export type SubmitHost = Pick<TerminalApi, 'submitCommand'>

export type AddCommandFn = (
  command: string,
  terminalName: string,
  terminalId: string,
  projectId: string
) => Promise<void>

export interface SubmitLogEvent {
  name: string
  detail: string
}

export interface SubmitDraftArgs {
  host: SubmitHost
  scheduler?: CompletionScheduler
  terminalId: string
  draft: string
  highlight?: string
  terminalName?: string
  projectId?: string
  addCommand?: AddCommandFn
  onReply?: (result: SessionRpcResult) => boolean | undefined
  setDraft?: (draft: string) => void
  log?: (event: SubmitLogEvent) => void
}

export interface SubmitDraftResult {
  result: SessionRpcResult
  committedSubmit: boolean
  draft: string
  editorMounted: boolean
}

/** The shell echoes the accepted command into xterm; the client does not paint it. */
export function handleAcceptedSubmit(_args: {
  command: string
  term?: { write: (data: string) => void }
}): void {}

export async function submitDraft(args: SubmitDraftArgs): Promise<SubmitDraftResult> {
  if (args.scheduler) await args.scheduler.prepareSubmit()
  const result = await args.host.submitCommand(args.terminalId, args.draft)
  args.onReply?.(result)
  if (result === 'Accepted') {
    try {
      await recordHistory(args)
    } catch {
      args.log?.({ name: 'history_failed', detail: 'save_failed' })
    }
    return { result, committedSubmit: true, draft: args.draft, editorMounted: false }
  }
  if (result === 'PreWrite') {
    args.setDraft?.(args.draft)
    return { result, committedSubmit: false, draft: args.draft, editorMounted: true }
  }
  if (result === 'Partial') {
    return { result, committedSubmit: false, draft: args.draft, editorMounted: false }
  }
  return { result, committedSubmit: false, draft: args.draft, editorMounted: true }
}

async function recordHistory(args: SubmitDraftArgs): Promise<void> {
  const { addCommand, terminalName, projectId, terminalId, draft } = args
  if (addCommand && terminalName !== undefined && projectId !== undefined) {
    await addCommand(draft, terminalName, terminalId, projectId)
  }
}
