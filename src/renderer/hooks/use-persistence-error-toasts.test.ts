import type { PersistenceErrorEvent, PersistenceErrorListener } from '@shared/types/ipc.types'
import { PERSISTENCE_ERROR_CODES } from '@shared/types/ipc.types'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PERSISTENCE_ERROR_TOAST_WINDOW_MS,
  persistenceErrorText,
  usePersistenceErrorToasts
} from './use-persistence-error-toasts'

const { mockOnPersistenceError, mockToastError, bus } = vi.hoisted(() => {
  const state: { listener: PersistenceErrorListener | null; unsubscribed: number } = {
    listener: null,
    unsubscribed: 0
  }
  return {
    bus: state,
    mockToastError: vi.fn(),
    mockOnPersistenceError: vi.fn((listener: PersistenceErrorListener) => {
      state.listener = listener
      return () => {
        state.listener = null
        state.unsubscribed++
      }
    })
  }
})

vi.mock('@/lib/api', () => ({ persistenceApi: { onPersistenceError: mockOnPersistenceError } }))
vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

function emit(event: Partial<PersistenceErrorEvent> = {}): void {
  bus.listener?.({
    key: 'chat-draft/p1/s1',
    code: 'STORE_VALUE_TOO_LARGE',
    message: 'raw host message',
    ...event
  })
}

describe('persistenceErrorText', () => {
  it('says the saved value is too large and was not saved', () => {
    expect(
      persistenceErrorText({ key: 'chat-draft/p1/s1', code: 'STORE_VALUE_TOO_LARGE', message: '' })
    ).toBe('Saved value for the chat draft is too large; it was not saved.')
  })

  it('has its own plain text for every code, each naming the value', () => {
    const texts = PERSISTENCE_ERROR_CODES.map((code) =>
      persistenceErrorText({ key: 'terminals/p1', code, message: 'raw host message' })
    )
    expect(new Set(texts).size).toBe(PERSISTENCE_ERROR_CODES.length)
    for (const text of texts) {
      expect(text).toContain('the terminal layout')
      expect(text).not.toContain('raw host message')
    }
  })

  it('names a value by its key when no friendly name exists', () => {
    expect(
      persistenceErrorText({ key: 'agents/last-selected', code: 'STORE_WRITE_FAILED', message: '' })
    ).toContain('"agents/last-selected"')
  })

  it.each([
    ['terminals/p1', 'the terminal layout'],
    ['snapshots/p1', 'the snapshots'],
    ['last-launch-draft/p1', 'the launch draft'],
    ['projects/p1/command-history', 'the command history'],
    ['acp/mention-recents/p1', 'the recent file mentions'],
    ['settings/app', 'the settings'],
    ['settings/recent-commands', 'the recent commands'],
    ['ssh/profiles', 'the SSH profiles'],
    ['sessions/auto-save', 'the session backup']
  ])('names %s as %s', (key, label) => {
    expect(persistenceErrorText({ key, code: 'STORE_PARTITION_FULL', message: '' })).toContain(
      label
    )
  })
})

describe('usePersistenceErrorToasts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    bus.listener = null
    bus.unsubscribed = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows an error toast with the human text for a failed write', () => {
    renderHook(() => usePersistenceErrorToasts())

    emit()

    expect(mockToastError).toHaveBeenCalledTimes(1)
    expect(mockToastError).toHaveBeenCalledWith(
      'Saved value for the chat draft is too large; it was not saved.',
      { id: 'persistence-error:STORE_VALUE_TOO_LARGE:chat-draft/p1/s1' }
    )
  })

  it('shows one toast per code and key within 30 seconds', () => {
    renderHook(() => usePersistenceErrorToasts())

    emit()
    vi.advanceTimersByTime(PERSISTENCE_ERROR_TOAST_WINDOW_MS - 1)
    emit()
    emit()

    expect(mockToastError).toHaveBeenCalledTimes(1)
  })

  it('shows the toast again once 30 seconds have passed', () => {
    renderHook(() => usePersistenceErrorToasts())

    emit()
    vi.advanceTimersByTime(PERSISTENCE_ERROR_TOAST_WINDOW_MS)
    emit()

    expect(mockToastError).toHaveBeenCalledTimes(2)
  })

  it('does not merge a different key or a different code', () => {
    renderHook(() => usePersistenceErrorToasts())

    emit()
    emit({ key: 'chat-draft/p1/s2' })
    emit({ code: 'STORE_PARTITION_FULL' })

    expect(mockToastError).toHaveBeenCalledTimes(3)
  })

  it('subscribes once and unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => usePersistenceErrorToasts())
    expect(mockOnPersistenceError).toHaveBeenCalledTimes(1)

    unmount()

    expect(bus.unsubscribed).toBe(1)
    emit()
    expect(mockToastError).not.toHaveBeenCalled()
  })
})
