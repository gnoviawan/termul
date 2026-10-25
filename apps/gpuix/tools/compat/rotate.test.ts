import { describe, expect, test } from 'bun:test'
import { rotateSource } from '../../src/compat/svg'
import { translation } from '../../src/compat/translate'

const CHEVRON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"></path></svg>'

describe('rotation baked into icons', () => {
  test('rotate-* classes are lifted as degrees', () => {
    expect(translation('svg', 'shrink-0 rotate-180').rotate).toBe(180)
    expect(translation('svg', 'shrink-0 -rotate-90').rotate).toBe(-90)
    expect(translation('span', 'rotate-[45deg]').rotate).toBe(45)
    expect(translation('svg', 'rotate-0').rotate).toBe(0)
    expect(translation('svg', 'shrink-0').rotate).toBeNull()
  })

  test('an icon turns about its viewBox centre', () => {
    expect(rotateSource(CHEVRON, 90)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"><g transform="rotate(90 12 12)"><path d="m9 18 6-6-6-6"></path></g></svg>'
    )
    expect(rotateSource('<svg width="10" height="20"><path d="M0 0"></path></svg>', -90)).toBe(
      '<svg width="10" height="20"><g transform="rotate(-90 5 10)"><path d="M0 0"></path></g></svg>'
    )
  })

  test('a whole turn leaves the markup alone', () => {
    expect(rotateSource(CHEVRON, 0)).toBe(CHEVRON)
    expect(rotateSource(CHEVRON, 360)).toBe(CHEVRON)
  })
})
