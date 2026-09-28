import { describe, expect, it } from 'vitest'
import { agentChatNeedsAttention, attentionCountForProject } from './agent-chat-attention'

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
