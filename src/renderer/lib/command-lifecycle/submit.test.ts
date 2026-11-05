import type { SessionRpcResult } from '@shared/types/command-session'
import type {
  CompletionReplyFields,
  CompletionRpcReply,
  TerminalApi
} from '@shared/types/ipc.types'
import { render } from '@testing-library/react'
import { createElement, useEffect } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useAddCommand } from '@/hooks/use-command-history'
import { useCommandHistoryStore } from '@/stores/command-history-store'
import { type CompletionContext, CompletionScheduler } from './completion'
import { handleAcceptedSubmit, submitDraft } from './submit'
import type { InputMode, SessionPhase } from './transition'

const { mockWrite } = vi.hoisted(() => ({
  mockWrite: vi.fn(async () => ({ success: true as const, data: undefined }))
}))

vi.mock('@/lib/api', () => ({ persistenceApi: { write: mockWrite } }))

beforeEach(() => {
  useCommandHistoryStore.setState({ entries: [] })
  mockWrite.mockClear()
})

function AddCommandProbe(props: {
  onReady: (addCommand: ReturnType<typeof useAddCommand>) => void
}) {
  const addCommand = useAddCommand()
  useEffect(() => {
    props.onReady(addCommand)
  }, [addCommand, props.onReady])
  return null
}

function hookAddCommand(): ReturnType<typeof useAddCommand> {
  let addCommand: ReturnType<typeof useAddCommand> | undefined
  render(
    createElement(AddCommandProbe, {
      onReady: (fn) => {
        addCommand = fn
      }
    })
  )
  if (!addCommand) throw new Error('useAddCommand did not ready')
  return addCommand
}

type CompletionRequest = Parameters<TerminalApi['requestCompletion']>[1]

function createFakeHost() {
  const calls: string[] = []
  const requests: Array<{ terminalId: string; request: CompletionRequest }> = []
  const pending: Array<{ resolve: (reply: CompletionRpcReply) => void }> = []
  const cancels: Array<{ terminalId: string; requestId: string }> = []
  const submits: Array<{ terminalId: string; draft: string }> = []
  let resolveCancel: ((result: SessionRpcResult) => void) | null = null

  return {
    calls,
    requests,
    cancels,
    submits,
    requestCompletion(terminalId: string, request: CompletionRequest) {
      requests.push({ terminalId, request })
      return new Promise<CompletionRpcReply>((resolve) => {
        pending.push({ resolve })
      })
    },
    cancelCompletion(terminalId: string, requestId: string) {
      calls.push('cancel')
      cancels.push({ terminalId, requestId })
      return new Promise<SessionRpcResult>((resolve) => {
        resolveCancel = resolve
      })
    },
    submitCommand(terminalId: string, draft: string) {
      calls.push('submit')
      submits.push({ terminalId, draft })
      return Promise.resolve('Accepted' as const)
    },
    drainCancel(result: SessionRpcResult = 'Accepted') {
      const resolve = resolveCancel
      resolveCancel = null
      if (!resolve) throw new Error('no in-flight cancel')
      resolve(result)
      return Promise.resolve()
    },
    async finish(reply: CompletionRpcReply) {
      const next = pending.shift()
      if (!next) throw new Error('no in-flight completion')
      next.resolve(reply)
      await Promise.resolve()
    }
  }
}

function context(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    terminalId: 't1',
    sessionId: 's1',
    mode: 'Editor' as InputMode,
    phase: 'AtPrompt' as SessionPhase,
    draft: 'git sta',
    bufferRevision: 4,
    cursor: 7,
    promptGeneration: 3,
    cwd: '/repo',
    ...overrides
  }
}

it('Enter submits the buffer', async () => {
  const host = createFakeHost()
  const applied: CompletionReplyFields[] = []
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true },
    onResult: (completion) => applied.push(completion)
  })

  scheduler.requestCompletion(context(), false)
  expect(host.requests).toHaveLength(1)
  scheduler.updateContext(context({ bufferRevision: 5, cursor: 8, draft: 'git stat' }))

  const pending = submitDraft({
    host,
    scheduler,
    terminalId: 't1',
    draft: 'git sta',
    highlight: 'git status'
  })

  expect(host.calls).toEqual(['cancel'])
  expect(host.cancels).toEqual([{ terminalId: 't1', requestId: 'A' }])
  expect(host.submits).toEqual([])

  await host.drainCancel()
  await pending

  expect(host.calls).toEqual(['cancel', 'submit'])
  expect(host.submits).toEqual([{ terminalId: 't1', draft: 'git sta' }])

  await host.finish({
    result: 'Accepted',
    outcome: 'Completed',
    completion: {
      request_id: 'A',
      buffer_revision: 4,
      cursor: 7,
      prompt_generation: 3,
      cwd: '/repo',
      output: 'status'
    }
  })

  expect(applied).toEqual([])
  expect(host.requests).toHaveLength(1)
})

it('accepted submit records history', async () => {
  const host = createFakeHost()
  const addCommand = hookAddCommand()
  const addCalls: Array<[string, string, string, string]> = []
  const recordAdd: typeof addCommand = async (command, terminalName, terminalId, projectId) => {
    addCalls.push([command, terminalName, terminalId, projectId])
    await addCommand(command, terminalName, terminalId, projectId)
  }

  await submitDraft({
    host,
    terminalId: 't1',
    terminalName: 'local',
    projectId: 'p1',
    draft: 'git sta',
    addCommand: recordAdd
  })

  expect(useCommandHistoryStore.getState().entries).toEqual([
    expect.objectContaining({
      command: 'git sta',
      terminalName: 'local',
      terminalId: 't1',
      projectId: 'p1'
    })
  ])
  expect(addCalls).toEqual([['git sta', 'local', 't1', 'p1']])
})

it('a pre-write failure restores the draft', async () => {
  let draft = 'make test'
  const history: Array<[string, string, string, string]> = []
  const host = {
    submitCommand(_terminalId: string, command: string) {
      return Promise.resolve(
        command === 'make test' ? ('PreWrite' as const) : ('Accepted' as const)
      )
    }
  }

  const result = await submitDraft({
    host,
    terminalId: 't1',
    terminalName: 'local',
    projectId: 'p1',
    draft,
    setDraft: (next) => {
      draft = next
    },
    addCommand: async (command, terminalName, terminalId, projectId) => {
      history.push([command, terminalName, terminalId, projectId])
    }
  })

  expect(result.draft).toBe('make test')
  expect(draft).toBe('make test')
  expect(history).toEqual([])
  expect(result.committedSubmit).toBe(false)
})

it('a partial submit stays down', async () => {
  const history: Array<[string, string, string, string]> = []
  const host = {
    submitCommand() {
      return Promise.resolve('Partial' as const)
    }
  }

  const result = await submitDraft({
    host,
    terminalId: 't1',
    terminalName: 'local',
    projectId: 'p1',
    draft: 'git sta',
    addCommand: async (command, terminalName, terminalId, projectId) => {
      history.push([command, terminalName, terminalId, projectId])
    }
  })

  expect(result.editorMounted).toBe(false)
  expect(history).toEqual([])
})

it('a history failure does not resubmit', async () => {
  const logs: string[] = []
  const submits: string[] = []
  const host = {
    submitCommand(_terminalId: string, draft: string) {
      submits.push(draft)
      return Promise.resolve('Accepted' as const)
    }
  }

  const result = await submitDraft({
    host,
    terminalId: 't1',
    terminalName: 'local',
    projectId: 'p1',
    draft: 'git sta',
    addCommand: async () => {
      throw new Error('persist failed')
    },
    log: (event) => {
      logs.push(`${event.name} ${event.detail}`)
    }
  })

  expect(submits).toEqual(['git sta'])
  expect(result.committedSubmit).toBe(true)
  expect(logs.join('\n')).not.toContain('git sta')
})

it('an empty enter is not history', async () => {
  const host = createFakeHost()
  const addCommand = hookAddCommand()

  await submitDraft({
    host,
    terminalId: 't1',
    terminalName: 'local',
    projectId: 'p1',
    draft: '',
    addCommand
  })

  expect(useCommandHistoryStore.getState().entries).toEqual([])
})

it('whitespace is not history', async () => {
  const host = createFakeHost()
  const addCommand = hookAddCommand()

  await submitDraft({
    host,
    terminalId: 't1',
    terminalName: 'local',
    projectId: 'p1',
    draft: '   ',
    addCommand
  })

  expect(useCommandHistoryStore.getState().entries).toEqual([])
})

it('history keeps internal newlines', async () => {
  const host = createFakeHost()
  const addCommand = hookAddCommand()

  await submitDraft({
    host,
    terminalId: 't1',
    terminalName: 'local',
    projectId: 'p1',
    draft: '  git\nstatus  ',
    addCommand
  })

  expect(useCommandHistoryStore.getState().entries).toEqual([
    expect.objectContaining({ command: 'git\nstatus' })
  ])
})

it('the client does not paint the command', () => {
  const writes: string[] = []
  const term = {
    write(data: string) {
      writes.push(data)
    }
  }

  handleAcceptedSubmit({ command: 'git remote -v', term })

  expect(writes.filter((data) => data.includes('git remote -v'))).toHaveLength(0)
})
