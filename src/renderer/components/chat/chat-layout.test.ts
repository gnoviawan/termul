import { describe, expect, it } from 'vitest'
import { NARROW_PANE_PX, resolveComposerToolbarMode } from './chat-layout'

describe('resolveComposerToolbarMode (Story 5.1)', () => {
  it('treats non-positive widths as wide (jsdom / pre-layout default)', () => {
    expect(resolveComposerToolbarMode(0)).toBe('wide')
    expect(resolveComposerToolbarMode(-1)).toBe('wide')
  })

  it('uses narrow below the pane threshold', () => {
    expect(resolveComposerToolbarMode(399)).toBe('narrow')
    expect(resolveComposerToolbarMode(375)).toBe('narrow')
    expect(resolveComposerToolbarMode(NARROW_PANE_PX - 1)).toBe('narrow')
  })

  it('uses wide at and above the pane threshold', () => {
    expect(resolveComposerToolbarMode(NARROW_PANE_PX)).toBe('wide')
    expect(resolveComposerToolbarMode(500)).toBe('wide')
    expect(resolveComposerToolbarMode(800)).toBe('wide')
  })
})
