import { describe, expect, it } from 'vitest'
import { measureSkillPadding, SKILL_CHIP_OVERHEAD_PX } from '@/lib/skill-chip-metrics'
import { SKILL_PAD_CHAR } from '@/lib/skill-tokens'

/**
 * `measureSkillPadding` uses canvas `measureText`, which jsdom does not provide
 * (no `canvas` package in devDependencies). These tests cover the no-canvas
 * degradation path (returns '') so the composer stays usable in jsdom and the
 * caret lands slightly behind the chip rather than crashing. Real browser
 * pixel-alignment is a manual/visual check (documented in the spec).
 */
describe('measureSkillPadding', () => {
  it('returns an empty string when no textarea is provided', () => {
    expect(measureSkillPadding('git-worktree', null)).toBe('')
  })

  it('returns an empty string in jsdom (no canvas 2d context) without throwing', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    try {
      const result = measureSkillPadding('git-worktree', ta)
      expect(result).toBe('')
    } finally {
      ta.remove()
    }
  })

  it('exposes the chip overhead constant matching SkillChip classes', () => {
    // px-1.5 (12) + border (2) + gap-1 (4) + Sparkles size 12 (12) = 30
    expect(SKILL_CHIP_OVERHEAD_PX).toBe(30)
  })
})

describe('SKILL_PAD_CHAR', () => {
  it('is FIGURE SPACE (U+2007)', () => {
    expect(SKILL_PAD_CHAR).toBe('\u2007')
  })
})
