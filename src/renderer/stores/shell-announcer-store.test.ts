import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetShellAnnouncerForTests,
  ANNOUNCE_DELAY_MS,
  useShellAnnouncerStore
} from './shell-announcer-store'

function message(): string {
  return useShellAnnouncerStore.getState().message
}

describe('shell announcer store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetShellAnnouncerForTests()
  })

  afterEach(() => {
    _resetShellAnnouncerForTests()
    vi.useRealTimers()
  })

  it('is inert while no region is mounted', () => {
    useShellAnnouncerStore.getState().announce('Turn finished')
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS * 5)
    expect(message()).toBe('')
  })

  it('never holds text before the delay elapses', () => {
    useShellAnnouncerStore.getState().registerRegion()
    expect(message()).toBe('')

    useShellAnnouncerStore.getState().announce('Turn finished')
    expect(message()).toBe('')
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 1)
    expect(message()).toBe('')
    vi.advanceTimersByTime(1)
    expect(message()).toBe('Turn finished')
  })

  it('replaces the previous message with the newest one', () => {
    useShellAnnouncerStore.getState().registerRegion()
    useShellAnnouncerStore.getState().announce('Turn finished')
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    expect(message()).toBe('Turn finished')

    useShellAnnouncerStore.getState().announce('Approval needed')
    // The old text is cleared immediately so the region is empty in between.
    expect(message()).toBe('')
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    expect(message()).toBe('Approval needed')
  })

  it('cancels a pending message when a newer one arrives (the last call wins)', () => {
    useShellAnnouncerStore.getState().registerRegion()
    useShellAnnouncerStore.getState().announce('Switching to docs…')
    useShellAnnouncerStore.getState().announce('Approval needed')
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS * 3)
    expect(message()).toBe('Approval needed')
  })

  it('clears then sets an identical repeat so it is announced again', () => {
    useShellAnnouncerStore.getState().registerRegion()
    const seen: string[] = []
    const unsubscribe = useShellAnnouncerStore.subscribe((state) => seen.push(state.message))

    useShellAnnouncerStore.getState().announce('Turn finished')
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    useShellAnnouncerStore.getState().announce('Turn finished')
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    unsubscribe()

    expect(seen).toEqual(['', 'Turn finished', '', 'Turn finished'])
  })

  it('resets the message and drops the pending one when the region unmounts', () => {
    const unregister = useShellAnnouncerStore.getState().registerRegion()
    useShellAnnouncerStore.getState().announce('Turn finished')
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    expect(message()).toBe('Turn finished')

    useShellAnnouncerStore.getState().announce('Approval needed')
    unregister()
    expect(message()).toBe('')
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS * 3)
    expect(message()).toBe('')
    expect(useShellAnnouncerStore.getState().regionCount).toBe(0)
  })

  it('keeps announcing while a second region registration is still mounted (StrictMode remount)', () => {
    const first = useShellAnnouncerStore.getState().registerRegion()
    const second = useShellAnnouncerStore.getState().registerRegion()
    first()
    useShellAnnouncerStore.getState().announce('Turn finished')
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS)
    expect(message()).toBe('Turn finished')

    second()
    expect(message()).toBe('')
  })

  it('ignores a second call to the same unregister function', () => {
    const first = useShellAnnouncerStore.getState().registerRegion()
    useShellAnnouncerStore.getState().registerRegion()
    first()
    first()
    expect(useShellAnnouncerStore.getState().regionCount).toBe(1)
  })
})
