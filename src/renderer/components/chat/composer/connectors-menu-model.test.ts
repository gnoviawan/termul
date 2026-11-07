import { describe, expect, it } from 'vitest'
import { connectorsMenuModel } from './connectors-menu-model'

const servers = [
  { id: 'gh', name: 'GitHub', enabled: true },
  { id: 'linear', name: 'Linear', enabled: true },
  { id: 'mobbin', name: 'mobbin', enabled: false },
  { id: 'docs', name: 'Docs' }
]

describe('connectorsMenuModel', () => {
  it('lists every server with its switch state and counts the ones that are on', () => {
    const model = connectorsMenuModel(servers, { linear: 'authRequired' }, 'chat-current')
    expect(model).toEqual({
      rows: [
        { id: 'gh', name: 'GitHub', on: true, needsSignIn: false },
        { id: 'linear', name: 'Linear', on: true, needsSignIn: true },
        { id: 'mobbin', name: 'mobbin', on: false, needsSignIn: false },
        { id: 'docs', name: 'Docs', on: true, needsSignIn: false }
      ],
      onCount: 3,
      footnote: 'none'
    })
  })

  it('tells a stale chat to reload and the launcher that changes apply to the next chat', () => {
    expect(connectorsMenuModel(servers, {}, 'chat-stale').footnote).toBe('reload-chat')
    expect(connectorsMenuModel(servers, {}, 'launcher').footnote).toBe('next-chat')
  })

  it('has no rows, count or footnote for an empty registry', () => {
    for (const host of ['chat-current', 'launcher'] as const) {
      expect(connectorsMenuModel([], undefined, host)).toEqual({
        rows: [],
        onCount: 0,
        footnote: 'none'
      })
    }
  })

  it('keeps the reload for a stale chat whose last connector was removed', () => {
    expect(connectorsMenuModel([], undefined, 'chat-stale').footnote).toBe('reload-chat')
  })
})
