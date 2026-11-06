import { describe, expect, it } from 'vitest'
import { contrastRatio, mixHex, TEXT_CONTRAST_MIN } from '@/lib/themes/color-utils'
import { labelColors } from './label-color'

describe('labelColors', () => {
  it('keeps a label colour that already reads on the surface', () => {
    expect(labelColors('ffffff', '#000000')).toEqual({
      ink: '#ffffff',
      wash: '#ffffff24',
      edge: '#ffffff73'
    })
  })

  it('lightens a dark label on a dark theme until its text reaches 4.5:1 on the washed chip', () => {
    const surface = '#0d1117'
    const colors = labelColors('0e3a8a', surface)
    if (!colors) throw new Error('expected colours')
    expect(colors.ink).not.toBe('#0e3a8a')
    const chip = mixHex(surface, '#0e3a8a', 0.14)
    expect(contrastRatio(colors.ink, chip)).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN)
  })

  it('darkens a pale label on a light theme', () => {
    const colors = labelColors('fbca04', '#ffffff')
    if (!colors) throw new Error('expected colours')
    const chip = mixHex('#ffffff', '#fbca04', 0.14)
    expect(contrastRatio(colors.ink, chip)).toBeGreaterThanOrEqual(TEXT_CONTRAST_MIN)
  })

  it('leaves the chip neutral for a colour that is not six hex digits, or no theme yet', () => {
    expect(labelColors('red', '#000000')).toBeNull()
    expect(labelColors('', '#000000')).toBeNull()
    expect(labelColors('d73a4a', '')).toBeNull()
  })
})
