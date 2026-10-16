import { describe, expect, it } from 'vitest'
import { CODEX_CLI_SIGNED_OUT_MESSAGE } from '@/lib/agents/codex-cli-auth'
import { RESUME_FAILED_PREFIX } from '@/stores/acp-store/helpers'
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
  pendingElicitation: false,
  lastError: null as string | null,
  ephemeral: false
}

const resumeFailed = `${RESUME_FAILED_PREFIX}agent exited`

describe('agentChatNeedsAttention', () => {
  it('is quiet for a live chat and for a finished turn', () => {
    expect(agentChatNeedsAttention(live)).toBe(false)
  })

  it('is Attention for a permission, a question, an elicitation, or a disconnected Agent', () => {
    expect(agentChatNeedsAttention({ ...live, pendingPermission: true })).toBe(true)
    expect(agentChatNeedsAttention({ ...live, pendingQuestion: true })).toBe(true)
    expect(agentChatNeedsAttention({ ...live, pendingElicitation: true })).toBe(true)
    expect(agentChatNeedsAttention({ ...live, agentStatus: 'disconnected' })).toBe(true)
    expect(agentChatNeedsAttention({ ...live, sessionStatus: 'error' })).toBe(false)
  })

  it('is quiet for a cleanly stopped chat: it resumes when the user types', () => {
    const closed = { ...live, sessionStatus: 'closed' as const, agentStatus: undefined }
    expect(agentChatNeedsAttention(closed)).toBe(false)
    expect(agentChatNeedsAttention({ ...closed, lastError: 'Turn ended: max tokens' })).toBe(false)
  })

  it('is Attention for a closed chat that cannot resume by itself', () => {
    const closed = { ...live, sessionStatus: 'closed' as const, agentStatus: undefined }
    expect(agentChatNeedsAttention({ ...closed, lastError: resumeFailed })).toBe(true)
    expect(agentChatNeedsAttention({ ...closed, lastError: CODEX_CLI_SIGNED_OUT_MESSAGE })).toBe(
      true
    )
  })

  it('keeps a pending permission as Attention whatever the status', () => {
    for (const sessionStatus of ['active', 'closed', 'error'] as const) {
      expect(agentChatNeedsAttention({ ...live, sessionStatus, pendingPermission: true })).toBe(
        true
      )
    }
  })

  it('reads a resume failure only on a closed chat', () => {
    expect(agentChatNeedsAttention({ ...live, lastError: resumeFailed })).toBe(false)
  })

  it('ignores an entrance warm-up', () => {
    expect(agentChatNeedsAttention({ ...live, ephemeral: true, pendingPermission: true })).toBe(
      false
    )
    expect(agentChatNeedsAttention({ ...live, ephemeral: true, pendingElicitation: true })).toBe(
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
        { ...live, projectId: 'b', sessionStatus: 'closed', lastError: resumeFailed },
        { ...live, sessionStatus: 'closed', lastError: resumeFailed },
        { ...live, sessionStatus: 'closed' }
      ])
    ).toBe(2)
  })

  it('counts an elicitation only for its own Project', () => {
    const chats = [
      { ...live, pendingElicitation: true },
      { ...live, projectId: 'b', pendingElicitation: true },
      { ...live, ephemeral: true, pendingElicitation: true }
    ]
    expect(attentionCountForProject('a', chats)).toBe(1)
    expect(attentionCountForProject('b', chats)).toBe(1)
    expect(attentionCountForProject('c', chats)).toBe(0)
  })
})
