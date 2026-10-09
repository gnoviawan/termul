import { compile } from 'tailwindcss'
import { describe, expect, it } from 'vitest'
import {
  CHAT_HIT_ICON,
  CHAT_HIT_MIN_H,
  NARROW_PANE_PX,
  resolveComposerToolbarMode
} from './chat-layout'

const classes = (value: string): string[] => value.split(/\s+/).filter(Boolean)

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

describe('CHAT_HIT_* landscape floor (L-24)', () => {
  it('keeps the 44px narrow step and the 40px wide step, then restores 44px on a coarse pointer', () => {
    expect(classes(CHAT_HIT_MIN_H)).toEqual([
      'min-h-11',
      '@[400px]:min-h-10',
      'pointer-coarse:@[400px]:min-h-11'
    ])
    expect(classes(CHAT_HIT_ICON)).toEqual([
      'relative',
      'inline-flex',
      'shrink-0',
      'items-center',
      'justify-center',
      'size-11',
      '@[400px]:size-10',
      'pointer-coarse:@[400px]:size-11'
    ])
  })

  it('does not force the narrow-pane step from the pane width alone', () => {
    // A fine pointer in a pane of 400px or wider still gets 40px.
    expect(CHAT_HIT_MIN_H).toContain('@[400px]:min-h-10')
    expect(CHAT_HIT_ICON).toContain('@[400px]:size-10')
    expect(CHAT_HIT_MIN_H).not.toMatch(/(^|\s)@\[400px\]:min-h-11/)
    expect(CHAT_HIT_ICON).not.toMatch(/(^|\s)@\[400px\]:size-11/)
  })

  it('emits the coarse restore after the 400px shrink, so it wins at equal specificity', async () => {
    // Pure string work: `compile` touches no DOM, so the default environment is fine.
    const compiler = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;')
    // Each `[shrink, restore]` is a pane-width step and the touch restore beside it:
    // the two shared tokens, then the inline steps on the composer card, its menu,
    // the queue and the jump button.
    const pairs = [
      ['@[400px]:min-h-10', 'pointer-coarse:@[400px]:min-h-11'],
      ['@[400px]:size-10', 'pointer-coarse:@[400px]:size-11'],
      ['@[400px]:after:-inset-y-1', 'pointer-coarse:@[400px]:after:-inset-y-1.5'],
      ['@[400px]:after:-inset-1', 'pointer-coarse:@[400px]:after:-inset-1.5'],
      ['@[400px]:min-h-8', 'pointer-coarse:@[400px]:min-h-11'],
      ['@[400px]:py-1.5', 'pointer-coarse:@[400px]:py-2.5'],
      ['@[400px]:h-10', 'pointer-coarse:@[400px]:h-11'],
      ['@[400px]:w-10', 'pointer-coarse:@[400px]:w-11']
    ]
    const css = compiler.build([
      ...classes(CHAT_HIT_MIN_H),
      ...classes(CHAT_HIT_ICON),
      ...pairs.flat()
    ])
    // A class name as it appears in a compiled selector: every symbol escaped.
    const selector = (name: string): string => `.${name.replace(/[^\w-]/g, (c) => `\\${c}`)}`

    for (const [shrink, restore] of pairs) {
      const shrinkAt = css.indexOf(selector(shrink))
      const restoreAt = css.indexOf(selector(restore))
      expect(shrinkAt, shrink).toBeGreaterThan(-1)
      expect(restoreAt, restore).toBeGreaterThan(shrinkAt)
    }

    // The restore is keyed on pointer type, inside the container query.
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*@container \(width >= 400px\)/)
  })
})

describe('inset focus ring in forced-colors mode (L-26)', () => {
  it('emits the inside offset after outline-hidden, so it wins over its 2px forced-colors offset', async () => {
    // `outline-hidden` paints `outline: 2px solid transparent; outline-offset: 2px`
    // under `forced-colors: active`; on a row with an `overflow-hidden` ancestor
    // that outward offset would be clipped. The negative offset must come later.
    const compiler = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;')
    const hidden = 'focus-visible:outline-hidden'
    const inset = 'focus-visible:-outline-offset-2'
    const css = compiler.build([inset, hidden])
    const selector = (name: string): string => `.${name.replace(/[^\w-]/g, (c) => `\\${c}`)}`

    expect(css).toContain('@media (forced-colors: active)')
    expect(css).toContain('outline: 2px solid transparent')
    const hiddenAt = css.indexOf(selector(hidden))
    const insetAt = css.indexOf(selector(inset))
    expect(hiddenAt, hidden).toBeGreaterThan(-1)
    expect(insetAt, inset).toBeGreaterThan(hiddenAt)
  })
})
