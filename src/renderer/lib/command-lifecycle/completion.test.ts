import type {
  CompletionReplyFields,
  CompletionRpcReply,
  TerminalApi
} from '@shared/types/ipc.types'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CLIENT_COMPLETION_TIMEOUT_MS,
  type CompletionContext,
  type CompletionLogEvent,
  CompletionScheduler
} from './completion'
import type { InputMode, SessionPhase } from './transition'

afterEach(() => {
  vi.useRealTimers()
})

type CompletionRequest = Parameters<TerminalApi['requestCompletion']>[1]

function createFakeHost() {
  const requests: Array<{ terminalId: string; request: CompletionRequest }> = []
  const pending: Array<{ resolve: (reply: CompletionRpcReply) => void }> = []
  const cancels: Array<{ terminalId: string; requestId: string }> = []

  return {
    requests,
    cancels,
    requestCompletion(terminalId: string, request: CompletionRequest) {
      requests.push({ terminalId, request })
      return new Promise<CompletionRpcReply>((resolve) => {
        pending.push({ resolve })
      })
    },
    cancelCompletion(terminalId: string, requestId: string) {
      cancels.push({ terminalId, requestId })
      return Promise.resolve('Accepted' as const)
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

function completedReply(fields: CompletionReplyFields): CompletionRpcReply {
  return { result: 'Accepted', outcome: 'Completed', completion: fields }
}

function matchingFields(overrides: Partial<CompletionReplyFields> = {}): CompletionReplyFields {
  return {
    request_id: 'A',
    buffer_revision: 4,
    cursor: 7,
    prompt_generation: 3,
    cwd: '/repo',
    output: 'status',
    ...overrides
  }
}

it('repeated Tab keeps the request', () => {
  const host = createFakeHost()
  const ids = ['A', 'B']
  let nextId = 0
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => ids[nextId++] ?? `extra-${nextId}`,
    settings: { automaticCompletionRefresh: true }
  })
  const ctx = context()

  scheduler.requestCompletion(ctx, false)

  expect(host.requests).toHaveLength(1)
  expect(host.requests[0]?.request).toMatchObject({ draft: ctx.draft })
  expect(scheduler.inFlightRequestId).toBe('A')

  scheduler.requestCompletion(ctx, false)

  expect(host.requests).toHaveLength(1)
  expect(host.requests[0]?.request.requestId).toBe('A')
  expect(scheduler.inFlightRequestId).toBe('A')
})

it('a context change coalesces one replacement', async () => {
  const host = createFakeHost()
  const applied: CompletionReplyFields[] = []
  const ids = ['A', 'B']
  let nextId = 0
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => ids[nextId++] ?? `extra-${nextId}`,
    settings: { automaticCompletionRefresh: true },
    onResult: (completion) => applied.push(completion)
  })

  scheduler.requestCompletion(context(), false)
  expect(host.requests).toHaveLength(1)
  expect(host.requests[0]?.request.requestId).toBe('A')

  scheduler.updateContext(context({ bufferRevision: 5, cursor: 8, draft: 'git stat' }))
  expect(host.requests).toHaveLength(1)

  await host.finish(
    completedReply({
      request_id: 'A',
      buffer_revision: 4,
      cursor: 7,
      prompt_generation: 3,
      cwd: '/repo',
      output: 'status'
    })
  )

  expect(applied.map((row) => row.request_id)).toEqual([])
  expect(host.requests).toHaveLength(2)
  expect(host.requests[1]?.request).toMatchObject({
    requestId: 'B',
    bufferRevision: 5,
    cursor: 8,
    promptGeneration: 3
  })
})

it('refresh off waits for Tab', async () => {
  const host = createFakeHost()
  const applied: CompletionReplyFields[] = []
  const ids = ['A', 'B']
  let nextId = 0
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => ids[nextId++] ?? `extra-${nextId}`,
    settings: { automaticCompletionRefresh: false },
    onResult: (completion) => applied.push(completion)
  })
  const typed = context({ bufferRevision: 5, cursor: 8, draft: 'git stat' })

  scheduler.requestCompletion(context(), false)
  expect(host.requests).toHaveLength(1)

  scheduler.updateContext(typed)
  expect(host.requests).toHaveLength(1)

  await host.finish(
    completedReply({
      request_id: 'A',
      buffer_revision: 4,
      cursor: 7,
      prompt_generation: 3,
      cwd: '/repo',
      output: 'status'
    })
  )

  expect(host.requests).toHaveLength(1)
  expect(applied).toEqual([])

  scheduler.requestCompletion(typed, false)

  expect(host.requests).toHaveLength(2)
  expect(host.requests[1]?.request).toMatchObject({
    requestId: 'B',
    bufferRevision: 5,
    cursor: 8,
    promptGeneration: 3
  })
})

it('typing requests one completion', async () => {
  vi.useFakeTimers()
  const host = createFakeHost()
  const results: CompletionReplyFields[] = []
  const draft = 'git sta'
  const clock = {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
  }
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true },
    clock,
    onResult: (row) => {
      results.push(row)
    }
  })
  const typed = context({ draft })

  scheduler.updateContext(typed)
  await vi.advanceTimersByTimeAsync(100)

  expect(host.requests).toHaveLength(1)
  expect(host.requests[0]?.request).toMatchObject({
    requestId: 'A',
    bufferRevision: 4,
    cursor: 7
  })
  expect(results).toEqual([])
  expect(draft).toBe('git sta')
})

it('a matching completion leaves the draft', async () => {
  const host = createFakeHost()
  const results: CompletionReplyFields[] = []
  const draft = 'git sta'
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true },
    onResult: (row) => {
      results.push(row)
    }
  })

  scheduler.requestCompletion(context({ draft }), false)
  expect(host.requests).toHaveLength(1)

  await host.finish(
    completedReply({
      request_id: 'A',
      buffer_revision: 4,
      cursor: 7,
      prompt_generation: 3,
      cwd: '/repo',
      output: 'status'
    })
  )

  expect(draft).toBe('git sta')
  expect(results).toEqual([
    {
      request_id: 'A',
      buffer_revision: 4,
      cursor: 7,
      prompt_generation: 3,
      cwd: '/repo',
      output: 'status'
    }
  ])
})

it('idle typing with refresh off does not request', async () => {
  vi.useFakeTimers()
  const host = createFakeHost()
  const clock = {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
  }
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: false },
    clock
  })

  scheduler.updateContext(context({ draft: 'git sta' }))
  await vi.advanceTimersByTimeAsync(100)

  expect(host.requests).toHaveLength(0)
})

it('a mismatched result is ignored', async () => {
  const cases: Array<{ completion: CompletionReplyFields; latest?: CompletionContext }> = [
    { completion: matchingFields({ request_id: 'other' }) },
    { completion: matchingFields({ buffer_revision: 99 }) },
    { completion: matchingFields({ cursor: 0 }) },
    { completion: matchingFields({ prompt_generation: 1 }) },
    { completion: matchingFields({ cwd: '/other' }) },
    { completion: matchingFields(), latest: context({ sessionId: 's2' }) },
    { completion: matchingFields(), latest: context({ mode: 'PTY' }) }
  ]

  for (const { completion, latest } of cases) {
    const host = createFakeHost()
    const results: CompletionReplyFields[] = []
    const draft = 'git sta'
    const scheduler = new CompletionScheduler({
      host,
      createRequestId: () => 'A',
      settings: { automaticCompletionRefresh: true },
      onResult: (row) => {
        results.push(row)
      }
    })

    scheduler.requestCompletion(context({ draft }), false)
    if (latest) scheduler.updateContext(latest)
    await host.finish(completedReply(completion))

    expect(results).toEqual([])
    expect(draft).toBe('git sta')
  }
})

it('a timeout leaves the draft', async () => {
  vi.useFakeTimers()
  const clock = {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
  }

  {
    const host = createFakeHost()
    const history: string[] = []
    const results: CompletionReplyFields[] = []
    const draft = 'git sta'
    const scheduler = new CompletionScheduler({
      host,
      createRequestId: () => 'A',
      settings: { automaticCompletionRefresh: true },
      clock,
      onResult: (row) => {
        results.push(row)
      }
    })

    scheduler.requestCompletion(context({ draft }), false)
    await host.finish({ result: 'Accepted', outcome: 'TimedOut' })

    expect(results).toEqual([])
    expect(draft).toBe('git sta')
    // The scheduler has no history dependency, so this recorder cannot be called.
    expect(history).toEqual([])
    expect(scheduler.inFlightRequestId).toBeNull()
  }

  {
    const host = createFakeHost()
    const history: string[] = []
    const results: CompletionReplyFields[] = []
    const logs: CompletionLogEvent[] = []
    const draft = 'git sta'
    const scheduler = new CompletionScheduler({
      host,
      createRequestId: () => 'A',
      settings: { automaticCompletionRefresh: true },
      clock,
      onResult: (row) => {
        results.push(row)
      },
      log: (event) => {
        logs.push(event)
      }
    })

    scheduler.requestCompletion(context({ draft }), false)
    await vi.advanceTimersByTimeAsync(CLIENT_COMPLETION_TIMEOUT_MS)

    expect(results).toEqual([])
    expect(draft).toBe('git sta')
    // The scheduler has no history dependency, so this recorder cannot be called.
    expect(history).toEqual([])
    expect(scheduler.inFlightRequestId).toBeNull()
    expect(logs.some((event) => event.detail.includes('Partial'))).toBe(true)
    expect(host.cancels).toEqual([{ terminalId: 't1', requestId: 'A' }])
  }
})

it('a finished request frees the client slot', async () => {
  const host = createFakeHost()
  const ids = ['A', 'B']
  let nextId = 0
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => ids[nextId++] ?? `extra-${nextId}`,
    settings: { automaticCompletionRefresh: true }
  })

  scheduler.requestCompletion(context(), false)
  expect(host.requests).toHaveLength(1)
  expect(scheduler.inFlightRequestId).toBe('A')

  await host.finish({ result: 'Accepted', outcome: 'TimedOut' })

  const next = context({ bufferRevision: 5, cursor: 8, draft: 'git stat' })
  scheduler.requestCompletion(next, false)

  expect(host.requests).toHaveLength(2)
  expect(host.requests[1]?.request).toMatchObject({
    requestId: 'B',
    bufferRevision: 5,
    cursor: 8,
    promptGeneration: 3
  })
  expect(scheduler.inFlightRequestId).toBe('B')
})

it('a late result is ignored', async () => {
  vi.useFakeTimers()
  const clock = {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
  }
  const host = createFakeHost()
  const results: CompletionReplyFields[] = []
  const draft = 'git sta'
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true },
    clock,
    onResult: (row) => {
      results.push(row)
    }
  })

  scheduler.requestCompletion(context({ draft }), false)
  await vi.advanceTimersByTimeAsync(CLIENT_COMPLETION_TIMEOUT_MS)
  expect(scheduler.inFlightRequestId).toBeNull()

  await host.finish(completedReply(matchingFields({ output: 'status' })))

  expect(results).toEqual([])
  expect(draft).toBe('git sta')
})

it('completion uses the prompt cwd', () => {
  const host = createFakeHost()
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true }
  })

  scheduler.requestCompletion(context({ cwd: '/repo' }), false)

  expect(host.requests).toHaveLength(1)
  expect(host.requests[0]?.request.cwd).toBe('/repo')
})

it('a missing cwd skips path completion', () => {
  const host = createFakeHost()
  const logs: CompletionLogEvent[] = []
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true },
    log: (event) => {
      logs.push(event)
    }
  })

  scheduler.requestCompletion(context({ cwd: '' }), false)

  expect(host.requests).toHaveLength(0)
  expect(logs.some((event) => event.detail.includes('missing_cwd'))).toBe(true)
})

it('NotStarted leaves the draft', async () => {
  const host = createFakeHost()
  const ids = ['A', 'B']
  let nextId = 0
  const results: CompletionReplyFields[] = []
  const draft = 'git sta'
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => ids[nextId++] ?? `extra-${nextId}`,
    settings: { automaticCompletionRefresh: true },
    onResult: (row) => {
      results.push(row)
    }
  })

  scheduler.requestCompletion(context({ draft: 'git sta' }), false)
  expect(host.requests).toHaveLength(1)

  scheduler.updateContext(context({ bufferRevision: 5, cursor: 8, draft: 'git stat' }))
  expect(host.requests).toHaveLength(1)

  await host.finish({ result: 'NotStarted' })

  expect(results).toEqual([])
  expect(draft).toBe('git sta')
  expect(host.requests).toHaveLength(1)
  expect(scheduler.inFlightRequestId).toBeNull()

  scheduler.requestCompletion(context({ bufferRevision: 5, cursor: 8, draft: 'git stat' }), false)
  expect(host.requests).toHaveLength(2)
  expect(host.requests[1]?.request.requestId).toBe('B')
})

it('no completion inside a quote or a word', async () => {
  vi.useFakeTimers()
  const clock = {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
  }
  const quoted = context({
    draft: 'echo "a b',
    cursor: 'echo "a b'.length,
    bufferRevision: 1
  })

  {
    const host = createFakeHost()
    const scheduler = new CompletionScheduler({
      host,
      createRequestId: () => 'A',
      settings: { automaticCompletionRefresh: true },
      clock
    })

    scheduler.updateContext(quoted)
    await vi.advanceTimersByTimeAsync(100)
    expect(host.requests).toHaveLength(0)

    scheduler.requestCompletion(quoted, false)
    expect(host.requests).toHaveLength(0)
  }

  {
    const host = createFakeHost()
    const scheduler = new CompletionScheduler({
      host,
      createRequestId: () => 'A',
      settings: { automaticCompletionRefresh: true },
      clock
    })
    scheduler.requestCompletion(context({ draft: 'git status', cursor: 6 }), false)
    expect(host.requests).toHaveLength(0)
  }

  {
    const host = createFakeHost()
    const scheduler = new CompletionScheduler({
      host,
      createRequestId: () => 'A',
      settings: { automaticCompletionRefresh: true },
      clock
    })
    scheduler.requestCompletion(context({ draft: 'git sta', cursor: 7 }), false)
    expect(host.requests).toHaveLength(1)
  }
})

it('idle typing with blank draft skips completion', async () => {
  vi.useFakeTimers()
  const host = createFakeHost()
  const logs: CompletionLogEvent[] = []
  const clock = {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
  }
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true },
    clock,
    log: (event) => {
      logs.push(event)
    }
  })

  scheduler.updateContext(context({ draft: '', cursor: 0 }))
  await vi.advanceTimersByTimeAsync(100)

  expect(host.requests).toHaveLength(0)
  expect(logs).toContainEqual({ name: 'completion_skipped', detail: 'reason=blank_draft' })
})

it('idle typing with whitespace draft skips completion', async () => {
  vi.useFakeTimers()
  const host = createFakeHost()
  const logs: CompletionLogEvent[] = []
  const clock = {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
  }
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true },
    clock,
    log: (event) => {
      logs.push(event)
    }
  })

  scheduler.updateContext(context({ draft: '   \n', cursor: 0 }))
  await vi.advanceTimersByTimeAsync(100)

  expect(host.requests).toHaveLength(0)
  expect(logs).toContainEqual({ name: 'completion_skipped', detail: 'reason=blank_draft' })
})

it('explicit Tab with blank draft and no request in flight calls host', () => {
  const host = createFakeHost()
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true }
  })

  scheduler.requestCompletion(context({ draft: '', cursor: 0 }), false)

  expect(host.requests).toHaveLength(1)
  expect(host.requests[0]?.request).toMatchObject({
    requestId: 'A',
    draft: '',
    cursor: 0
  })
})

it('replacement request skips blank draft', async () => {
  const host = createFakeHost()
  const applied: CompletionReplyFields[] = []
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true },
    onResult: (completion) => applied.push(completion)
  })

  scheduler.requestCompletion(context({ draft: 'git ', bufferRevision: 4, cursor: 4 }), false)
  expect(host.requests).toHaveLength(1)

  scheduler.updateContext(context({ draft: '', bufferRevision: 5, cursor: 0 }))
  expect(host.requests).toHaveLength(1)

  await host.finish(
    completedReply(
      matchingFields({
        request_id: 'A',
        buffer_revision: 4,
        cursor: 4
      })
    )
  )

  expect(host.requests).toHaveLength(1)
  expect(applied).toEqual([])
})

it('client timeout skips replacement on blank draft', async () => {
  vi.useFakeTimers()
  const clock = {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
  }
  const host = createFakeHost()
  const applied: CompletionReplyFields[] = []
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true },
    clock,
    onResult: (completion) => applied.push(completion)
  })

  scheduler.requestCompletion(context({ draft: 'git ', bufferRevision: 4, cursor: 4 }), false)
  expect(host.requests).toHaveLength(1)

  scheduler.updateContext(context({ draft: '', bufferRevision: 5, cursor: 0 }))
  expect(host.requests).toHaveLength(1)

  await vi.advanceTimersByTimeAsync(CLIENT_COMPLETION_TIMEOUT_MS)

  expect(host.requests).toHaveLength(1)
  expect(applied).toEqual([])
})

it('Tab on blank only requests when idle', async () => {
  const host = createFakeHost()
  const logs: CompletionLogEvent[] = []
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings: { automaticCompletionRefresh: true },
    log: (event) => {
      logs.push(event)
    }
  })

  scheduler.requestCompletion(context({ draft: 'git ', bufferRevision: 4, cursor: 4 }), false)
  expect(host.requests).toHaveLength(1)

  const blankContext = context({ draft: '', bufferRevision: 5, cursor: 0 })
  scheduler.updateContext(blankContext)
  scheduler.requestCompletion(blankContext, false)

  expect(logs).toContainEqual({
    name: 'completion_tab_ignored',
    detail: 'requestId=A'
  })

  await host.finish(
    completedReply(
      matchingFields({
        request_id: 'A',
        buffer_revision: 4,
        cursor: 4
      })
    )
  )

  expect(host.requests).toHaveLength(1)
})
