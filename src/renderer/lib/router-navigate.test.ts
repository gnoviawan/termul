import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearChatRoute, setRouterNavigate } from './router-navigate'

describe('clearChatRoute', () => {
  afterEach(() => {
    setRouterNavigate(null)
    window.location.hash = ''
  })

  it('leaves any chat route when no session is given', () => {
    const navigate = vi.fn()
    setRouterNavigate(navigate)
    window.location.hash = '#/c/s-1'
    clearChatRoute()
    expect(navigate).toHaveBeenCalledWith('/')
  })

  it('only leaves the route when it still names the given session', () => {
    const navigate = vi.fn()
    setRouterNavigate(navigate)
    window.location.hash = '#/c/s-newer'
    clearChatRoute('s-stale')
    expect(navigate).not.toHaveBeenCalled()
    clearChatRoute('s-newer')
    expect(navigate).toHaveBeenCalledWith('/')
  })
})
