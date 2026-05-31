import { describe, it, expect, beforeEach } from 'vitest'
import { usePinnedCommandsStore } from './pinned-commands-store'

describe('pinned-commands-store', () => {
  beforeEach(() => {
    usePinnedCommandsStore.setState({ pinnedCommandIds: [] })
  })

  it('starts with an empty pinned list', () => {
    expect(usePinnedCommandsStore.getState().pinnedCommandIds).toEqual([])
  })

  it('toggles a command on (appends in insertion order)', () => {
    const { togglePinned } = usePinnedCommandsStore.getState()
    togglePinned('a')
    togglePinned('b')

    expect(usePinnedCommandsStore.getState().pinnedCommandIds).toEqual(['a', 'b'])
  })

  it('toggles a command off when already pinned', () => {
    const { togglePinned } = usePinnedCommandsStore.getState()
    togglePinned('a')
    togglePinned('b')
    togglePinned('a')

    expect(usePinnedCommandsStore.getState().pinnedCommandIds).toEqual(['b'])
  })

  it('does not impose a cap on pinned commands', () => {
    const { togglePinned } = usePinnedCommandsStore.getState()
    for (let i = 0; i < 12; i++) {
      togglePinned(`cmd-${i}`)
    }

    expect(usePinnedCommandsStore.getState().pinnedCommandIds).toHaveLength(12)
  })

  it('replaces the list with setPinned', () => {
    const { setPinned } = usePinnedCommandsStore.getState()
    setPinned(['x', 'y', 'z'])

    expect(usePinnedCommandsStore.getState().pinnedCommandIds).toEqual(['x', 'y', 'z'])
  })
})
