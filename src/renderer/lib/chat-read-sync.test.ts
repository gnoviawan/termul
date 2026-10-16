import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import type { AcpTransport } from '@/lib/acp-transport'
import type { WatchHandlers } from '@/lib/acp-transport/watch-client'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { markChatRead, noteTurnEndSeq, startChatReadSync } from './chat-read-sync'

function fakeSurface(
  markChatReadImpl = vi.fn(async (sessionId: string, seq: number) => ({ sessionId, seq }))
) {
  let watch: WatchHandlers | null = null
  const transport = {
    watches: {
      subscribe: (name: string, handlers: WatchHandlers) => {
        expect(name).toBe('chat_reads')
        watch = handlers
        return () => {
          watch = null
        }
      }
    },
    markChatRead: markChatReadImpl
  } as unknown as AcpTransport
  return {
    transport,
    readState: (marks: Record<string, number>) => watch?.onState({ marks }),
    readDelta: (sessionId: string, seq: number) => watch?.onDelta?.({ sessionId, seq }),
    watching: () => watch !== null
  }
}

function unreadIds(): string[] {
  return Object.keys(useAgentChatUnreadStore.getState().unread).sort()
}

beforeEach(() => {
  useAgentChatUnreadStore.setState({
    unread: {},
    unreadSince: {},
    seenTurnEndSeq: {},
    sharedReadSeq: {}
  })
})

describe('startChatReadSync', () => {
  it('clears the dot banked here when another surface reads the same turn end', () => {
    const desktop = fakeSurface()
    const stop = startChatReadSync(desktop.transport)
    desktop.readState({})
    useAgentChatUnreadStore.getState().markUnread('s1', 0)
    useAgentChatUnreadStore.getState().markUnread('s2', 0)
    noteTurnEndSeq('s1', 7)
    noteTurnEndSeq('s2', 9)

    desktop.readDelta('s1', 7)

    expect(unreadIds()).toEqual(['s2'])
    stop()
    expect(desktop.watching()).toBe(false)
  })

  it('keeps the dot when the other surface is behind the newest turn end', () => {
    const desktop = fakeSurface()
    startChatReadSync(desktop.transport)
    useAgentChatUnreadStore.getState().markUnread('s1', 0)
    noteTurnEndSeq('s1', 7)
    noteTurnEndSeq('s1', 15)

    desktop.readState({ s1: 7 })

    expect(unreadIds()).toEqual(['s1'])
  })
})

describe('noteTurnEndSeq', () => {
  it('ignores a turn end that carries no seq', () => {
    noteTurnEndSeq('s1', undefined)
    noteTurnEndSeq('s1', 0)

    expect(useAgentChatUnreadStore.getState().seenTurnEndSeq).toEqual({})
  })
})

describe('markChatRead', () => {
  it('applies the host marker from the reply', async () => {
    const reply = vi.fn(async (sessionId: string) => ({ sessionId, seq: 11 }))
    const phone = fakeSurface(reply)

    markChatRead('s1', 7, phone.transport)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reply).toHaveBeenCalledWith('s1', 7)
    expect(useAgentChatUnreadStore.getState().sharedReadSeq).toEqual({ s1: 11 })
  })

  it('never lowers the marker with a reply that lost the race to a newer delta', async () => {
    const reply = vi.fn(async (sessionId: string) => ({ sessionId, seq: 15 }))
    const phone = fakeSurface(reply)
    startChatReadSync(phone.transport)
    phone.readState({})

    markChatRead('s3', 15, phone.transport)
    phone.readDelta('s3', 20)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAgentChatUnreadStore.getState().sharedReadSeq).toEqual({ s3: 20 })
  })

  it('sends a seq once while it is in flight and again after a failure', async () => {
    const failing = vi.fn(async () => {
      throw new Error('host gone')
    })
    const phone = fakeSurface(failing)

    markChatRead('s2', 7, phone.transport)
    markChatRead('s2', 7, phone.transport)
    markChatRead('s2', 5, phone.transport)
    expect(failing).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 0))

    markChatRead('s2', 7, phone.transport)
    expect(failing).toHaveBeenCalledTimes(2)
    expect(failing).toHaveBeenLastCalledWith('s2', 7)
  })
})
