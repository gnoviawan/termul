import { beforeEach, describe, expect, it } from 'vitest'
import { useSidebarStore } from './sidebar-store'

describe('sidebar-store', () => {
  beforeEach(() => {
    useSidebarStore.setState({
      isVisible: true
    })
  })

  it('starts visible by default', () => {
    expect(useSidebarStore.getState().isVisible).toBe(true)
  })

  it('toggles visibility', () => {
    useSidebarStore.getState().toggleVisibility()
    expect(useSidebarStore.getState().isVisible).toBe(false)

    useSidebarStore.getState().toggleVisibility()
    expect(useSidebarStore.getState().isVisible).toBe(true)
  })

  it('sets visibility directly', () => {
    useSidebarStore.getState().setVisible(false)
    expect(useSidebarStore.getState().isVisible).toBe(false)

    useSidebarStore.getState().setVisible(true)
    expect(useSidebarStore.getState().isVisible).toBe(true)
  })
})
