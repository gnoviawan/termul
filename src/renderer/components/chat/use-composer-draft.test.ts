import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seedComposerDraft, useComposerDraft } from './use-composer-draft'

const persistence = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  writeDebounced: vi.fn(),
  delete: vi.fn()
}))
vi.mock('@/lib/api', () => ({ persistenceApi: persistence }))

beforeEach(() => {
  vi.clearAllMocks()
  persistence.read.mockResolvedValue({ success: true, data: null })
  persistence.write.mockResolvedValue({ success: true })
  persistence.writeDebounced.mockResolvedValue({ success: true })
  persistence.delete.mockResolvedValue({ success: true })
})

describe('seedComposerDraft', () => {
  it('opens the chat composer on the seeded draft without sending it, and persists it', async () => {
    seedComposerDraft('p1', 'chat-1', 'Work on issue #12')
    expect(persistence.write).toHaveBeenCalledWith('chat-draft/p1/chat-1', 'Work on issue #12')

    const { result } = renderHook(() =>
      useComposerDraft({ projectId: 'p1', sessionId: 'chat-1', seedNonce: undefined })
    )
    await waitFor(() => expect(result.current[0]).toBe('Work on issue #12'))
    expect(persistence.read).not.toHaveBeenCalled()
  })

  it('never deletes the persisted seed while the composer picks it up', async () => {
    seedComposerDraft('p1', 'chat-3', 'Fix issue #3')
    const { result } = renderHook(() =>
      useComposerDraft({ projectId: 'p1', sessionId: 'chat-3', seedNonce: undefined })
    )
    await waitFor(() => expect(result.current[0]).toBe('Fix issue #3'))
    await waitFor(() =>
      expect(persistence.writeDebounced).toHaveBeenCalledWith(
        'chat-draft/p1/chat-3',
        'Fix issue #3'
      )
    )
    expect(persistence.delete).not.toHaveBeenCalled()

    act(() => result.current[1](''))
    expect(persistence.delete).toHaveBeenCalledWith('chat-draft/p1/chat-3')
  })

  it('applies a draft seeded for the real session after the placeholder re-keys', async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useComposerDraft({ projectId: 'p1', sessionId, seedNonce: undefined }),
      { initialProps: { sessionId: 'ph-1' } }
    )
    await waitFor(() => expect(persistence.read).toHaveBeenCalledTimes(1))

    act(() => seedComposerDraft('p1', 'chat-2', 'Fix the crash'))
    rerender({ sessionId: 'chat-2' })

    await waitFor(() => expect(result.current[0]).toBe('Fix the crash'))
  })
})
