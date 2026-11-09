/**
 * Issue #1595: the host's pending approval, question and elicitation lists a
 * (re)subscribe carries are installed into the store — a missing request comes
 * back (with the history watermark unable to hide it), an answered one is
 * dropped, and an answer still on its way is not undone.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { respondPermissionMock, answerQuestionMock, respondElicitationMock } = vi.hoisted(() => ({
  respondPermissionMock: vi.fn(),
  answerQuestionMock: vi.fn(),
  respondElicitationMock: vi.fn()
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/acp-api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/acp-api')>()
  return {
    ...actual,
    acpApi: {
      ...actual.acpApi,
      respondPermission: respondPermissionMock,
      answerQuestion: answerQuestionMock,
      respondElicitation: respondElicitationMock
    }
  }
})

import type {
  AskUserQuestionEvent,
  ElicitationRequestEvent,
  PermissionRequestEvent
} from '@/lib/acp-api'
import type { PendingPrompts } from '@/lib/acp-transport/pending-permissions'
import { useAcpStore } from '@/stores/acp-store'
import { syncPendingPrompts } from './pending-permission-sync'
import { historySeqWatermarks } from './shared-state'
import { FRESH } from './testkit'

const SID = 'sess-1'

function request(requestId: string, sessionId = SID): PermissionRequestEvent {
  return {
    agentId: 'agent-1',
    sessionId,
    requestId,
    toolCall: { toolCallId: `tc-${requestId}`, title: 'Run tests' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
  }
}

function question(questionId: string, sessionId = SID): AskUserQuestionEvent {
  return {
    agentId: 'agent-1',
    sessionId,
    questionId,
    question: 'Which branch?',
    options: [{ value: 'main', label: 'main' }]
  }
}

function elicitation(requestId: string, sessionId = SID): ElicitationRequestEvent {
  return {
    agentId: 'agent-1',
    sessionId,
    requestId,
    mode: 'form',
    message: 'Pick a plan',
    fields: [{ name: 'plan', kind: 'string', required: true, options: [] }]
  }
}

const syncPrompts = (sessionId: string, prompts: Partial<PendingPrompts>) =>
  syncPendingPrompts(useAcpStore.getState, useAcpStore.setState, sessionId, {
    permissions: null,
    questions: null,
    elicitations: null,
    ...prompts
  })

const sync = (sessionId: string, requests: PermissionRequestEvent[]) =>
  syncPrompts(sessionId, { permissions: requests })

const pendingIds = () => Object.keys(useAcpStore.getState().pendingPermissions).sort()
const questionIds = () => Object.keys(useAcpStore.getState().pendingQuestions).sort()
const elicitationIds = () => Object.keys(useAcpStore.getState().pendingElicitations).sort()

beforeEach(() => {
  useAcpStore.setState(FRESH)
  historySeqWatermarks.clear()
  respondPermissionMock.mockReset()
  answerQuestionMock.mockReset()
  respondElicitationMock.mockReset()
})

describe('syncPendingPrompts: approvals', () => {
  it('restores an approval the reconnect lost, even below the history watermark', () => {
    // The installed payload covers seqs up to 40: a replayed request at seq 12
    // is dropped as history, and the snapshot never holds the request.
    historySeqWatermarks.set(SID, 40)
    useAcpStore.getState()._onPermissionRequest(request('perm-1'), 12)
    expect(pendingIds()).toEqual([])

    sync(SID, [request('perm-1')])
    const pending = useAcpStore.getState().pendingPermissions['perm-1']
    expect(pending).toMatchObject({ requestId: 'perm-1', sessionId: SID, agentId: 'agent-1' })
    expect(pending.options).toEqual(request('perm-1').options)
  })

  it('drops an approval of the session the host no longer holds and keeps other sessions', () => {
    useAcpStore.getState()._onPermissionRequest(request('perm-answered'))
    useAcpStore.getState()._onPermissionRequest(request('perm-other', 'sess-2'))

    sync(SID, [request('perm-1')])
    expect(pendingIds()).toEqual(['perm-1', 'perm-other'])

    sync(SID, [])
    expect(pendingIds()).toEqual(['perm-other'])
  })

  it('keeps an existing entry instead of replacing it', () => {
    useAcpStore.getState()._onPermissionRequest(request('perm-1'))
    const before = useAcpStore.getState().pendingPermissions['perm-1']
    sync(SID, [request('perm-1')])
    expect(useAcpStore.getState().pendingPermissions['perm-1']).toBe(before)
  })

  it('does not bring back an approval whose answer is still on its way', async () => {
    useAcpStore.getState()._onPermissionRequest(request('perm-1'))
    let finish: () => void = () => {}
    respondPermissionMock.mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    const answering = useAcpStore.getState().respondPermission('perm-1', 'allow')
    // A list taken before the host processed the answer still names it.
    sync(SID, [request('perm-1')])
    expect(pendingIds()).toEqual([])
    finish()
    await answering
    expect(pendingIds()).toEqual([])
  })
})

describe('syncPendingPrompts: questions and elicitations', () => {
  it('restores an elicitation the reopen dropped as history', () => {
    // Reopen mid-elicitation: the payload watermark (210) covers the request
    // persisted at seq 209 while no client was connected.
    historySeqWatermarks.set(SID, 210)
    useAcpStore.getState()._onElicitationRequest(elicitation('el-1'), 209)
    expect(elicitationIds()).toEqual([])

    syncPrompts(SID, { elicitations: [elicitation('el-1')] })
    expect(useAcpStore.getState().pendingElicitations['el-1']).toMatchObject({
      requestId: 'el-1',
      sessionId: SID,
      agentId: 'agent-1',
      mode: 'form',
      message: 'Pick a plan'
    })
  })

  it('restores a Troupe ask_user question the reopen dropped as history', () => {
    historySeqWatermarks.set(SID, 40)
    useAcpStore.getState()._onQuestionRequest(question('q-1'), 30)
    expect(questionIds()).toEqual([])

    syncPrompts(SID, { questions: [question('q-1')] })
    expect(useAcpStore.getState().pendingQuestions['q-1']).toMatchObject({
      questionId: 'q-1',
      sessionId: SID,
      question: 'Which branch?'
    })
  })

  it('renders only the elicitation still pending when an earlier one of the turn was answered', () => {
    historySeqWatermarks.set(SID, 210)
    useAcpStore.getState()._onElicitationRequest(elicitation('el-a'), 200)
    useAcpStore.getState()._onElicitationRequest(elicitation('el-b'), 209)

    syncPrompts(SID, { elicitations: [elicitation('el-b')] })
    expect(elicitationIds()).toEqual(['el-b'])
  })

  it('drops prompts another device answered and keeps other sessions', () => {
    useAcpStore.getState()._onQuestionRequest(question('q-a'))
    useAcpStore.getState()._onQuestionRequest(question('q-other', 'sess-2'))
    useAcpStore.getState()._onElicitationRequest(elicitation('el-a'))
    useAcpStore.getState()._onElicitationRequest(elicitation('el-other', 'sess-2'))

    syncPrompts(SID, { questions: [], elicitations: [] })
    expect(questionIds()).toEqual(['q-other'])
    expect(elicitationIds()).toEqual(['el-other'])
  })

  it('leaves a kind alone when the reply carried no list for it', () => {
    useAcpStore.getState()._onPermissionRequest(request('perm-1'))
    useAcpStore.getState()._onQuestionRequest(question('q-1'))
    useAcpStore.getState()._onElicitationRequest(elicitation('el-1'))

    syncPrompts(SID, { permissions: [] })
    expect(pendingIds()).toEqual([])
    expect(questionIds()).toEqual(['q-1'])
    expect(elicitationIds()).toEqual(['el-1'])
  })

  it('does not bring back a question whose answer is still on its way', async () => {
    useAcpStore.getState()._onQuestionRequest(question('q-1'))
    let finish: () => void = () => {}
    answerQuestionMock.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
    const answering = useAcpStore.getState().answerQuestion('q-1', ['main'])
    syncPrompts(SID, { questions: [question('q-1')] })
    expect(questionIds()).toEqual([])
    finish()
    await answering
    expect(questionIds()).toEqual([])
  })

  it('does not bring back an elicitation whose answer is still on its way', async () => {
    useAcpStore.getState()._onElicitationRequest(elicitation('el-1'))
    let finish: () => void = () => {}
    respondElicitationMock.mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    const answering = useAcpStore.getState().respondElicitation('el-1', 'accept', { plan: 'pro' })
    syncPrompts(SID, { elicitations: [elicitation('el-1')] })
    expect(elicitationIds()).toEqual([])
    finish()
    await answering
    expect(elicitationIds()).toEqual([])
  })

  it('restores an elicitation once its answer has settled and the host still lists it', async () => {
    useAcpStore.getState()._onElicitationRequest(elicitation('el-1'))
    respondElicitationMock.mockResolvedValue(undefined)
    await useAcpStore.getState().respondElicitation('el-1', 'accept', { plan: 'pro' })
    syncPrompts(SID, { elicitations: [elicitation('el-1')] })
    expect(elicitationIds()).toEqual(['el-1'])
  })
})
