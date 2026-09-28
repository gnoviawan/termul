import { describe, expect, it } from 'vitest'
import {
  agentChatIsRunning,
  agentChatNeedsAttention,
  attentionCountForProject,
  needsYouLabel
} from './agent-chat-attention'

const live = {
  projectId: 'a',
  sessionStatus: 'active' as const,
  agentStatus: 'connected',
  pendingPermission: false,
  pendingQuestion: false,
  ephemeral: false
}

describe('agentChatNeedsAttention', () => {
  it('is quiet for a live chat and for a finished turn', () => {
    expect(agentChatNeedsAttention(live)).toBe(false)
  })

  it('is Attention for a permission, a question, or an Agent process stop', () => {
    expect(agentChatNeedsAttention({ ...live, pendingPermission: true })).toBe(true)
    expect(agentChatNeedsAttention({ ...live, pendingQuestion: true })).toBe(true)
    expect(agentChatNeedsAttention({ ...live, sessionStatus: 'closed' })).toBe(true)
    expect(agentChatNeedsAttention({ ...live, agentStatus: 'disconnected' })).toBe(true)
    expect(agentChatNeedsAttention({ ...live, sessionStatus: 'error' })).toBe(false)
  })

  it('ignores an entrance warm-up', () => {
    expect(agentChatNeedsAttention({ ...live, ephemeral: true, pendingPermission: true })).toBe(
      false
    )
  })
})

describe('agentChatIsRunning', () => {
  it('is running when the process is connected and the turn is idle', () => {
    expect(agentChatIsRunning({ ...live, activeTurn: false })).toBe(true)
  })

  it('leaves a live turn to the activity spinner', () => {
    expect(agentChatIsRunning({ ...live, activeTurn: true })).toBe(false)
    expect(agentChatIsRunning({ ...live, sessionStatus: 'closed' })).toBe(false)
  })
})

describe('needsYouLabel', () => {
  it('uses the singular label for one chat', () => {
    expect(needsYouLabel(1)).toBe('1 needs you')
    expect(needsYouLabel(2)).toBe('2 need you')
  })
})

describe('attentionCountForProject', () => {
  it('counts only that Project’s Agent chats in Attention', () => {
    expect(
      attentionCountForProject('a', [
        live,
        { ...live, pendingPermission: true },
        { ...live, projectId: 'b', sessionStatus: 'closed' },
        { ...live, sessionStatus: 'closed' }
      ])
    ).toBe(2)
  })
})
