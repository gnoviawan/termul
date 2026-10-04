import { describe, expect, it } from 'vitest'
import { unableTo } from './recovery-copy'

describe('unableTo', () => {
  it('names the action and a recovery when there is no detail', () => {
    expect(unableTo('create a terminal')).toBe('Unable to create a terminal. Try again.')
  })

  it('keeps a cause and still tells the user what to do next', () => {
    expect(unableTo('switch branch', 'checkout failed')).toBe(
      'Unable to switch branch. checkout failed. Try again.'
    )
  })

  it('does not stack a second recovery onto a message that already has one', () => {
    expect(unableTo('create a terminal', 'Unable to create a terminal. Try again.')).toBe(
      'Unable to create a terminal. Try again.'
    )
  })

  it('accepts a more specific recovery', () => {
    expect(unableTo('copy', null, 'Select Copy and try again.')).toBe(
      'Unable to copy. Select Copy and try again.'
    )
  })
})
