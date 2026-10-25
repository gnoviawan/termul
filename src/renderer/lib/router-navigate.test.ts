import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearChatRoute,
  consumeStorePlacedRoute,
  isChatRouteCurrent,
  navigateToChatSession,
  setRouterNavigate
} from './router-navigate'

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

describe('isChatRouteCurrent', () => {
  afterEach(() => {
    window.location.hash = ''
  })

  it('matches the path of the chat route and ignores its search part', () => {
    window.location.hash = '#/c/s-1?from=link'
    expect(isChatRouteCurrent('s-1')).toBe(true)
    expect(isChatRouteCurrent('s-10')).toBe(false)
    window.location.hash = '#/c/s-10'
    expect(isChatRouteCurrent('s-1')).toBe(false)
    window.location.hash = '#/'
    expect(isChatRouteCurrent('s-1')).toBe(false)
  })
})

describe('consumeStorePlacedRoute', () => {
  afterEach(() => {
    consumeStorePlacedRoute('s-1')
    consumeStorePlacedRoute('s-2')
    setRouterNavigate(null)
    window.location.hash = ''
  })

  it('answers once for the chat the store navigated to', () => {
    setRouterNavigate(vi.fn())
    navigateToChatSession('s-1')
    expect(consumeStorePlacedRoute('s-1')).toBe(true)
    expect(consumeStorePlacedRoute('s-1')).toBe(false)
  })

  it('does not mark a chat whose route was already current', () => {
    setRouterNavigate(vi.fn())
    window.location.hash = '#/c/s-1'
    navigateToChatSession('s-1')
    expect(consumeStorePlacedRoute('s-1')).toBe(false)
  })

  it('keeps only the latest store navigation', () => {
    setRouterNavigate(vi.fn())
    navigateToChatSession('s-1')
    navigateToChatSession('s-2')
    expect(consumeStorePlacedRoute('s-1')).toBe(false)
    expect(consumeStorePlacedRoute('s-2')).toBe(true)
  })
})
