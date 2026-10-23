import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { CheckIcon, Search01Icon } from '@hugeicons/core-free-icons'
import { iconSource } from '../../src/icons/hugeicons'
import { cometSource } from '../../src/ui/spinner'
import { domKey, splitDescendantClasses } from '../../src/ui/internal/host'
import { centeredClasses } from '../../src/ui/internal/modal'
import { gpuixTwin } from './alias'
import { GPUIX_ICONS, generateIcons, WEB_ICONS } from './gen-icons'

const APP = path.resolve(import.meta.dir, '../..')
const GPUIX_UI = path.join(APP, 'src/ui')
const WEB_UI = path.resolve(APP, '../../src/renderer/components/ui')

describe('icons', () => {
  test('the generated module matches the web icon module', () => {
    expect(readFileSync(GPUIX_ICONS, 'utf8')).toBe(generateIcons(readFileSync(WEB_ICONS, 'utf8')))
  })

  test('every element sets stroke once, so GPUI can parse the SVG', () => {
    const source = iconSource(Search01Icon as never, 2)
    for (const element of source.match(/<(path|circle|rect|line)[^>]*>/g) ?? []) {
      expect(element.match(/ stroke="/g)?.length).toBe(1)
      expect(element.match(/ stroke-width="/g)?.length).toBe(1)
    }
    expect(source).toContain('stroke-width="2"')
    expect(source).not.toContain('currentColor')
  })

  test('the check glyph keeps its path and paints black', () => {
    expect(iconSource(CheckIcon as never, 1.5)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 13.2592L7.58583 15.9568C8.2525 16.6523 8.58583 17 9.00004 17C9.41425 17 9.74759 16.6523 10.4143 15.9568L19 7" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" stroke="#000"/></svg>'
    )
  })
})

describe('spinner', () => {
  test('the comet ring has 72 wedges and a head at the top', () => {
    const source = cometSource(16, 0)
    expect(source.match(/<path /g)?.length).toBe(72)
    expect(source).toContain('<circle fill="#000" cx="8" cy="0.96" r="0.96"/>')
    expect(source).toContain('rotate(0 8 8)')
    expect(cometSource(16, 90)).toContain('rotate(90 8 8)')
  })
})

describe('host', () => {
  test('GPUI key names become DOM key names', () => {
    expect(['down', 'up', 'enter', 'escape', 'space', 'tab', 'a', 'f5'].map(domKey)).toEqual([
      'ArrowDown',
      'ArrowUp',
      'Enter',
      'Escape',
      ' ',
      'Tab',
      'a',
      'F5'
    ])
  })

  test('[&_svg] classes are split off for descendant icons', () => {
    expect(splitDescendantClasses('gap-2 [&_svg]:size-4 [&_svg]:shrink-0 rounded-lg')).toEqual({
      own: 'gap-2 rounded-lg',
      svg: 'size-4 shrink-0'
    })
  })

  test('dialog centring classes are dropped and grid becomes a column', () => {
    expect(
      centeredClasses('fixed left-[50%] top-[50%] z-50 grid w-full translate-x-[-50%] translate-y-[-50%] gap-4')
    ).toBe('z-50 flex flex-col w-full gap-4')
  })
})

describe('alias', () => {
  test('ui and icon specifiers with a GPUIX twin resolve to it', () => {
    expect(gpuixTwin('@/components/ui/button')).toBe(path.join(GPUIX_UI, 'button.tsx'))
    expect(gpuixTwin('@/components/ui/menu-styles')).toBe(path.join(GPUIX_UI, 'menu-styles.ts'))
    expect(gpuixTwin('@/components/icons')).toBe(path.join(APP, 'src/icons/index.tsx'))
  })

  test('names without a twin fall through to the web file', () => {
    expect(gpuixTwin('@/components/ui/button-variants')).toBeUndefined()
    expect(gpuixTwin('@/components/ui/message-scroller')).toBeUndefined()
    expect(gpuixTwin('@/lib/utils')).toBeUndefined()
  })
})

/**
 * Class strings copied from a web primitive must stay equal to it: every long
 * class literal in a GPUIX ui module appears verbatim in its web twin.
 */
describe('class drift', () => {
  const CLASS_LITERAL = /'([a-z0-9[\]&_:/%.()=!-]+(?: [a-z0-9[\]&_:/%.()=!-]+){4,})'/g
  const files = readdirSync(GPUIX_UI).filter((file) => /\.tsx?$/.test(file))
  for (const file of files) {
    const web = path.join(WEB_UI, file)
    test(file, () => {
      const source = readFileSync(path.join(GPUIX_UI, file), 'utf8')
      const webSource = readFileSync(web, 'utf8')
      const literals = [...source.matchAll(CLASS_LITERAL)].map((match) => match[1])
      const missing = literals.filter((literal) => !webSource.includes(literal))
      expect(missing).toEqual([])
    })
  }
})
