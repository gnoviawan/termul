import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  findTextFieldTags,
  listSourceFiles,
  type RawFieldTag,
  toRootPath
} from './__tests__/raw-field-source'
import { Command, CommandInput } from './command'
import { Input } from './input'
import {
  BAND_FOCUS_CLASS,
  FIELD_FOCUS_CLASS,
  FOCUS_RING_CLASS,
  INNER_FIELD_FOCUS_CLASS,
  PANEL_FIELD_CLASS
} from './panel-styles'
import { PopoverSearchBand } from './popover-search-band'
import { Select, SelectTrigger, SelectValue } from './select'
import { Textarea } from './textarea'

window.HTMLElement.prototype.scrollIntoView = vi.fn()

/**
 * Text fields show keyboard focus one way, in the `--focus-ring` token
 * (component-tokens.ts): a bordered field's hairline turns `--focus-ring` with
 * a 1px ring outside it, a borderless filled field gets a 2px ring, and a field inside a search
 * band leaves the edge to the band's hairline. Each uses `focus-visible` with
 * `outline-hidden`, so forced-colors mode still draws a system outline.
 */
const classes = (value: string | null): string[] => (value ?? '').split(/\s+/).filter(Boolean)
const classOf = (element: Element): string[] => classes(element.getAttribute('class'))

describe('field focus constants', () => {
  it('use the --focus-ring token on focus-visible and keep a forced-colors outline', () => {
    for (const value of [FIELD_FOCUS_CLASS, FOCUS_RING_CLASS, INNER_FIELD_FOCUS_CLASS]) {
      expect(classes(value)).toContain('focus-visible:outline-hidden')
      expect(value).not.toMatch(/primary|outline-none|(?<![\w-])focus:/)
    }
    expect(classes(FIELD_FOCUS_CLASS)).toEqual(
      expect.arrayContaining([
        'focus-visible:border-focus-ring',
        'focus-visible:ring-1',
        'focus-visible:ring-focus-ring'
      ])
    )
    expect(classes(FOCUS_RING_CLASS)).toEqual(
      expect.arrayContaining(['focus-visible:ring-2', 'focus-visible:ring-focus-ring'])
    )
    expect(classes(BAND_FOCUS_CLASS)).toEqual(['focus-within:border-focus-ring'])
  })

  it('panel field takes the bordered field focus', () => {
    expect(classes(PANEL_FIELD_CLASS)).toEqual(
      expect.arrayContaining(['border-field-border', ...classes(FIELD_FOCUS_CLASS)])
    )
    expect(classes(PANEL_FIELD_CLASS)).not.toContain('outline-none')
  })
})

describe('shared field primitives', () => {
  it.each([
    ['Input', () => render(<Input aria-label="Field" />)],
    ['Textarea', () => render(<Textarea aria-label="Field" />)]
  ])('%s turns its hairline ring on focus, with no offset ring', (_name, mount) => {
    mount()
    const list = classOf(screen.getByLabelText('Field'))
    expect(list).toEqual(expect.arrayContaining(classes(FIELD_FOCUS_CLASS)))
    expect(list.some((c) => c.includes('ring-offset') || c.includes('ring-2'))).toBe(false)
  })

  it('SelectTrigger matches the text fields', () => {
    render(
      <Select>
        <SelectTrigger aria-label="Field">
          <SelectValue />
        </SelectTrigger>
      </Select>
    )
    const list = classOf(screen.getByRole('combobox', { name: 'Field' }))
    expect(list).toEqual(expect.arrayContaining(classes(FIELD_FOCUS_CLASS)))
    expect(list.some((c) => c.startsWith('focus:'))).toBe(false)
  })

  it('CommandInput leaves the edge to its band hairline', () => {
    render(
      <Command>
        <CommandInput aria-label="Field" />
      </Command>
    )
    const input = screen.getByLabelText('Field')
    expect(classOf(input)).toEqual(expect.arrayContaining(classes(INNER_FIELD_FOCUS_CLASS)))
    expect(classOf(input)).not.toContain('focus-visible:ring-1')
    expect(classOf(input.parentElement as Element)).toEqual(
      expect.arrayContaining(['border-b', 'border-border', BAND_FOCUS_CLASS])
    )
  })

  it('PopoverSearchBand draws no box around the input; the band hairline shows focus', () => {
    render(
      <PopoverSearchBand value="" onChange={() => {}} placeholder="Search" ariaLabel="Search" />
    )
    const input = screen.getByRole('textbox', { name: 'Search' })
    expect(classOf(input)).not.toEqual(expect.arrayContaining(['focus-visible:ring-1']))
    expect(classOf(input.parentElement as Element)).toContain(BAND_FOCUS_CLASS)
  })
})

const FOCUS_CONSTANTS = [
  'FIELD_FOCUS_CLASS',
  'FOCUS_RING_CLASS',
  'INNER_FIELD_FOCUS_CLASS',
  'PANEL_FIELD_CLASS'
]
/** Blue focus, `focus:` (also on mouse click for selects) and an outline removed in forced colors. */
const FORBIDDEN =
  /(?<![\w-])(?:focus(?:-visible)?:(?:ring|border)-primary|focus:(?:ring|border|outline)[\w[\]/.-]*|outline-none|ring-offset-\d)(?![\w-])/

function findFocusOffenders(source: string): Array<RawFieldTag & { reason: string }> {
  const offenders: Array<RawFieldTag & { reason: string }> = []
  for (const field of findTextFieldTags(source)) {
    const forbidden = FORBIDDEN.exec(field.tag)
    if (forbidden) offenders.push({ ...field, reason: `uses ${forbidden[0]}` })
    else if (!FOCUS_CONSTANTS.some((name) => field.tag.includes(name))) {
      offenders.push({ ...field, reason: 'has no shared focus class' })
    }
  }
  return offenders
}

describe('findFocusOffenders', () => {
  it('accepts each shared focus class', () => {
    for (const name of FOCUS_CONSTANTS) {
      expect(findFocusOffenders(`<input className={\`h-8 \${${name}}\`} />`)).toEqual([])
    }
  })

  it('flags blue, focus: and outline-none focus styles', () => {
    for (const bad of [
      'focus:ring-1 focus:ring-primary',
      'focus-visible:ring-primary',
      'focus:border-primary',
      'focus:outline-none',
      'outline-none',
      'ring-offset-2'
    ]) {
      expect(findFocusOffenders(`<input className="${bad} \${FIELD_FOCUS_CLASS}" />`)).toHaveLength(
        1
      )
    }
  })

  it('flags a field with no focus style, and skips checkboxes', () => {
    expect(findFocusOffenders('<input className="h-8 border" />')[0]?.reason).toBe(
      'has no shared focus class'
    )
    expect(findFocusOffenders('<input type="checkbox" className="focus:ring-primary" />')).toEqual(
      []
    )
  })
})

const RENDERER_ROOT = join(__dirname, '..', '..')

describe('raw text fields in the renderer', () => {
  it('every <input>, <textarea> and <select> uses a shared neutral focus class', () => {
    const report: string[] = []
    let scanned = 0
    for (const path of listSourceFiles(RENDERER_ROOT)) {
      const source = readFileSync(path, 'utf8')
      scanned += findTextFieldTags(source).length
      for (const { line, reason } of findFocusOffenders(source)) {
        report.push(`src/renderer/${toRootPath(RENDERER_ROOT, path)}:${line} ${reason}`)
      }
    }
    expect(scanned).toBeGreaterThan(30)
    expect(
      report,
      `Use FIELD_FOCUS_CLASS (bordered), FOCUS_RING_CLASS (borderless filled) or INNER_FIELD_FOCUS_CLASS (inside a BAND_FOCUS_CLASS band) from ui/panel-styles:\n${report.join('\n')}`
    ).toEqual([])
  })
})

/** A focus ring, border or outline in a status or brand colour instead of the neutral `ring`. */
const FOCUS_COLOR =
  'primary|accent|destructive|success|warning|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white'
const COLORED_FOCUS = new RegExp(
  `(?<![\\w-])focus(?:-visible|-within)?:(?:ring|border|outline)-(?:${FOCUS_COLOR})(?:-\\d+)?(?![\\w-])`
)

describe('focus colour on every control', () => {
  it('flags a coloured focus ring and accepts the neutral ring', () => {
    expect(COLORED_FOCUS.test('focus-visible:ring-primary/60')).toBe(true)
    expect(COLORED_FOCUS.test('focus-visible:ring-destructive')).toBe(true)
    expect(COLORED_FOCUS.test('focus-within:border-primary')).toBe(true)
    expect(COLORED_FOCUS.test('focus-visible:ring-ring')).toBe(false)
    expect(COLORED_FOCUS.test('focus-visible:ring-primary-foreground/40')).toBe(false)
    expect(COLORED_FOCUS.test('focus-visible:ring-red-500')).toBe(true)
    expect(COLORED_FOCUS.test('focus:border-blue-500')).toBe(true)
    expect(COLORED_FOCUS.test('focus-visible:ring-white')).toBe(true)
  })

  it('no renderer source uses a coloured focus state', () => {
    const report: string[] = []
    for (const path of listSourceFiles(RENDERER_ROOT, ['.tsx', '.ts'])) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((text, index) => {
          if (COLORED_FOCUS.test(text)) {
            report.push(`src/renderer/${toRootPath(RENDERER_ROOT, path)}:${index + 1}`)
          }
        })
    }
    expect(
      report,
      `Focus is the neutral ring token (docs/design/colors.md). Use focus-visible:ring-ring:\n${report.join('\n')}`
    ).toEqual([])
  })
})
