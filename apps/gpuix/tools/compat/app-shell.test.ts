import { describe, expect, test } from 'bun:test'
import { jsx } from 'react/jsx-runtime'
import { hasContainerClasses, resolveContainerClasses } from '../../src/compat/container'
import { jsxs } from '../../src/compat/jsx-runtime'
import { type Placement, placeStyle } from '../../src/compat/placement'
import { defaultFilter, splitPartClasses } from '../../src/compat/shims/cmdk-model'
import { resolveViewportUnits, translation } from '../../src/compat/translate'

describe('viewport lengths', () => {
  test('arbitrary vh and vw values become px of the window', () => {
    expect(
      resolveViewportUnits('flex h-[90vh] md:h-[85vh] md:w-[90vw] max-h-[52vh] pt-[7vh]', 1280, 800)
    ).toBe('flex h-[720px] md:h-[680px] md:w-[1152px] max-h-[416px] pt-[56px]')
  })

  test('dynamic viewport units and calc() operands are resolved too; other classes are untouched', () => {
    expect(
      resolveViewportUnits('h-[100dvh] max-h-[calc(100vh-2rem)] overflow-hidden', 1000, 700)
    ).toBe('h-[700px] max-h-[calc(700px-2rem)] overflow-hidden')
    expect(resolveViewportUnits('h-screen w-full overflow-visible', 1000, 700)).toBe(
      'h-screen w-full overflow-visible'
    )
  })
})

describe('cmdk stand-in', () => {
  test("an ancestor's [&_[cmdk-part]] classes are split out per part", () => {
    expect(
      splitPartClasses(
        'flex [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-item]]:py-3 rounded-md'
      )
    ).toEqual({
      own: 'flex rounded-md',
      parts: { 'group-heading': 'px-2.5 text-xs', item: 'py-3' }
    })
  })

  test('the filter keeps substrings and in-order letters, and drops the rest', () => {
    expect(defaultFilter('App Preferences open global application preferences', 'prefs')).toBe(0.5)
    expect(defaultFilter('New Terminal', 'term')).toBe(1)
    expect(defaultFilter('New Terminal', '')).toBe(1)
    expect(defaultFilter('New Terminal', 'xyz')).toBe(0)
    expect(defaultFilter('alpha', 'repo', ['repository'])).toBe(1)
  })
})

describe('container queries', () => {
  test('@[w]: variants are kept at or above the container width and dropped below it', () => {
    const classes = '@container flex flex-col @[35rem]:flex-row @[400px]:px-5 gap-2'
    expect(resolveContainerClasses(classes, 624)).toBe('flex flex-col flex-row px-5 gap-2')
    expect(resolveContainerClasses(classes, 500)).toBe('flex flex-col px-5 gap-2')
    expect(resolveContainerClasses(classes, 399)).toBe('flex flex-col gap-2')
    expect(resolveContainerClasses(classes, null)).toBe('flex flex-col gap-2')
  })

  test('only container classes route through the host', () => {
    expect(hasContainerClasses('px-3 @[400px]:px-5')).toBe(true)
    expect(hasContainerClasses('@container flex')).toBe(true)
    expect(hasContainerClasses('flex gap-2')).toBe(false)
    expect(hasContainerClasses('after:content-["@"]')).toBe(false)
  })
})

describe('placement idioms', () => {
  test('a vertically centred icon keeps its right inset on a centring wrapper', () => {
    const tr = translation('span', 'absolute right-1.5 top-1/2 size-5 -translate-y-1/2')
    expect(tr.placement).toEqual({ centerX: false, centerY: true, popup: null })
    const placed = placeStyle(tr.base, tr.placement as Placement)
    expect(placed?.inner).toMatchObject({ position: 'relative', width: 20, height: 20 })
    expect(placed?.inner).not.toHaveProperty('right')
    const wrapper = placed?.wrap(jsx('div', {}))
    expect((wrapper?.props as { style: unknown }).style).toEqual({
      position: 'absolute',
      display: 'flex',
      pointerEvents: 'none',
      right: 6,
      top: 0,
      bottom: 0,
      alignItems: 'center'
    })
  })

  test('a bottom-full menu becomes an anchored popup on the top side with its margin as the gap', () => {
    const tr = translation(
      'div',
      'absolute bottom-full left-2 right-2 mb-1 rounded-xl bg-popover p-1'
    )
    expect(tr.placement).toEqual({ centerX: false, centerY: false, popup: 'top' })
    const placed = placeStyle(tr.base, tr.placement as Placement)
    expect(placed?.inner).not.toHaveProperty('marginBottom')
    expect(placed?.inner).not.toHaveProperty('position')
    const popup = placed?.wrap(jsx('div', {}))
    expect(popup?.props).toMatchObject({ side: 'top', gap: 4, offsets: { left: 8, right: 8 } })
  })

  test('half an idiom is left to tw()', () => {
    expect(translation('div', 'absolute top-1/2 left-0').placement).toBeNull()
  })
})

describe('button layout', () => {
  test('a plain button centres its content; a flex button lays it out from the start', () => {
    expect(translation('button', 'px-2').base).toMatchObject({
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center'
    })
    const flex = translation('button', 'flex gap-2 px-2').base
    expect(flex.display).toBe('flex')
    expect(flex.justifyContent).toBeUndefined()
    expect(flex.alignItems).toBeUndefined()
  })
})

describe('calc(100% - x) widths', () => {
  test('a centred box keeps the subtracted width as even padding on a full-width row', () => {
    const tr = translation('div', 'relative mx-auto -mt-4 flex w-[calc(100%-2.75rem)] items-center')
    expect(tr.fillMinus).toBe(44)
    const element = jsxs('div', {
      className: 'relative mx-auto -mt-4 flex w-[calc(100%-2.75rem)] items-center',
      children: ['a', 'b']
    })
    const props = element.props as {
      style: Record<string, unknown>
      children: { props: { style: Record<string, unknown> } }
    }
    expect(props.style).toEqual({
      display: 'flex',
      flexDirection: 'row',
      width: '100%',
      flexShrink: 0,
      paddingLeft: 22,
      paddingRight: 22
    })
    expect(props.children.props.style).toMatchObject({ flexGrow: 1, minWidth: 0, marginTop: -16 })
    expect(props.children.props.style).not.toHaveProperty('width')
  })
})

describe('positioned children', () => {
  function Icon(_props: { className?: string }) {
    return null
  }

  test('a centred icon component is wrapped and painted after the input it sits on', () => {
    const field = jsxs('div', {
      className: 'relative',
      children: [
        jsx(Icon, {
          className:
            'pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground'
        }),
        jsxs('input', { className: 'h-8 w-full' }),
        ''
      ]
    })
    const kids = (field.props as { children: unknown[] }).children
    const types = kids.map((kid) =>
      kid && typeof kid === 'object' ? (kid as { type: unknown }).type : kid
    )
    expect(types[0]).toBeNull()
    expect(types[1]).toBe('input')
    const wrapper = kids[kids.length - 1] as {
      key: string
      props: { style: unknown; children: { props: { className: string } } }
    }
    expect(wrapper.key).toBe('$positioned0')
    expect(wrapper.props.style).toEqual({
      position: 'absolute',
      display: 'flex',
      pointerEvents: 'none',
      left: 10,
      top: 0,
      bottom: 0,
      alignItems: 'center'
    })
    expect(wrapper.props.children.props.className).toBe('pointer-events-none text-muted-foreground')
  })
})
