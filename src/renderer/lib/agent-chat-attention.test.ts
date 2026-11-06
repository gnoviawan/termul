import { describe, expect, it } from 'vitest'
import { CODEX_CLI_SIGNED_OUT_MESSAGE } from '@/lib/agents/codex-cli-auth'
import { chatActivityRecord } from '@/lib/test-utils/chat-activity'
import { RESUME_FAILED_PREFIX } from '@/stores/acp-store/helpers'
import {
  agentChatIsRunning,
  chatNeedsYou,
  chatProjectId,
  needsYouLabel
} from './agent-chat-attention'

const live = {
  projectId: 'a',
  sessionStatus: 'active' as const,
  agentStatus: 'connected',
  lastError: null as string | null,
  ephemeral: false
}

const session = { projectId: 'a', status: 'active' as const, lastError: null }
const closed = { ...session, status: 'closed' as const }
const resumeFailed = `${RESUME_FAILED_PREFIX}agent exited`
const waiting = chatActivityRecord({ needsYou: true })

describe('chatNeedsYou', () => {
  it('is quiet for a live chat and for a finished turn', () => {
    expect(chatNeedsYou(undefined, session, 'connected')).toBe(false)
    expect(chatNeedsYou(chatActivityRecord({ unread: true }), session, 'connected')).toBe(false)
  })

  it('follows the host for a pending prompt, whether or not this renderer opened the chat', () => {
    expect(chatNeedsYou(waiting, undefined, undefined)).toBe(true)
    expect(chatNeedsYou(waiting, closed, undefined)).toBe(true)
  })

  it('is Needs you for a disconnected Agent of an opened chat', () => {
    expect(chatNeedsYou(undefined, session, 'disconnected')).toBe(true)
    expect(chatNeedsYou(undefined, { ...session, status: 'error' }, 'connected')).toBe(false)
    expect(chatNeedsYou(undefined, undefined, 'disconnected')).toBe(false)
  })

  it('is quiet for a cleanly stopped chat: it resumes when the user types', () => {
    expect(chatNeedsYou(undefined, closed, undefined)).toBe(false)
    expect(
      chatNeedsYou(undefined, { ...closed, lastError: 'Turn ended: max tokens' }, undefined)
    ).toBe(false)
  })

  it('is Needs you for a closed chat that cannot resume by itself', () => {
    expect(chatNeedsYou(undefined, { ...closed, lastError: resumeFailed }, undefined)).toBe(true)
    expect(
      chatNeedsYou(undefined, { ...closed, lastError: CODEX_CLI_SIGNED_OUT_MESSAGE }, undefined)
    ).toBe(true)
  })

  it('reads a resume failure only on a closed chat', () => {
    expect(chatNeedsYou(undefined, { ...session, lastError: resumeFailed }, 'connected')).toBe(
      false
    )
  })

  it('ignores the local reasons of an unattributed session stub', () => {
    expect(chatNeedsYou(undefined, { ...session, projectId: '' }, 'disconnected')).toBe(false)
  })
})

describe('chatProjectId', () => {
  it("prefers the host's project and falls back to the opened session's", () => {
    expect(chatProjectId(chatActivityRecord({ projectId: 'host' }), session)).toBe('host')
    expect(chatProjectId(chatActivityRecord({ projectId: null }), session)).toBe('a')
    expect(chatProjectId(undefined, undefined)).toBeUndefined()
  })

  it('names no project for the unassigned sentinel', () => {
    expect(chatProjectId(chatActivityRecord({ projectId: '__unassigned__' }), undefined)).toBe(
      undefined
    )
  })
})

describe('agentChatIsRunning', () => {
  it('is running when the process is connected and the turn is idle', () => {
    expect(agentChatIsRunning({ ...live, activeTurn: false })).toBe(true)
  })

  it('leaves a live turn to the activity spinner', () => {
    expect(agentChatIsRunning({ ...live, activeTurn: true })).toBe(false)
    expect(agentChatIsRunning({ ...live, sessionStatus: 'closed', activeTurn: false })).toBe(false)
  })
})

describe('needsYouLabel', () => {
  it('uses the singular label for one chat', () => {
    expect(needsYouLabel(1)).toBe('1 needs you')
    expect(needsYouLabel(2)).toBe('2 need you')
  })
})
