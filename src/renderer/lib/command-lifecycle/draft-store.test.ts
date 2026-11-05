import { expect, it } from 'vitest'
import { createCommandDraftStore } from './draft-store'

it('live editor remounts its draft', () => {
  const store = createCommandDraftStore()
  expect(store.read('terminal-a')).toBe('')
  store.offer('terminal-a', 'Editor', 'make test')
  expect(store.read('terminal-a')).toBe('make test')
  expect(store.read('terminal-a')).toBe('make test')
  expect(store).not.toHaveProperty('kill')
  expect(store.read('terminal-b')).toBe('')
})

it('process exit drops the stored draft', () => {
  const store = createCommandDraftStore()
  store.offer('terminal-a', 'Editor', 'make test')
  store.offer('terminal-b', 'Editor', 'keep this')
  store.processExited('terminal-a')
  expect(store.read('terminal-a')).toBe('')
  expect(store.read('terminal-b')).toBe('keep this')
})

it('accepted submit clears the stored draft', () => {
  const store = createCommandDraftStore()
  store.offer('terminal-a', 'Editor', 'git sta')
  store.offer('terminal-b', 'Editor', 'keep this')
  store.submitAccepted('terminal-a')
  expect(store.read('terminal-a')).toBe('')
  expect(store.read('terminal-b')).toBe('keep this')
})
