import { describe, expect, test } from 'bun:test'
import type { StyleDesc } from '@gpuix/react'
import { resolveTwTheme } from '../theme'
import { classifyClass, createTw } from '../tw'

const tw = createTw(resolveTwTheme('termul'))

/**
 * Class strings copied from Termul components, with the style a user sees in
 * the termul dark theme on a desktop-width window. Colours are the theme's
 * tokens painted in sRGB (#rrggbb, #rrggbbaa when translucent).
 */
const CASES: [string, StyleDesc][] = [
  [
    'block text-xs font-medium text-muted-foreground mb-1',
    {
      display: 'block',
      fontWeight: 500,
      color: '#8a8f98',
      marginBottom: 4,
      fontSize: 12,
      lineHeight: 16
    }
  ],
  [
    'fixed inset-0 bg-overlay/60 backdrop-blur-sm z-50 flex items-center justify-center',
    {
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: '#00000099',
      backdropBlur: 8,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  ],
  [
    'text-muted-foreground hover:text-foreground transition-colors',
    { color: '#8a8f98', hover: { color: '#e5e5e6' } }
  ],
  [
    'shrink-0 text-2xs tabular-nums text-muted-foreground',
    {
      fontFamily: 'Inter Variable Tabular',
      flexShrink: 0,
      color: '#8a8f98',
      fontSize: 12,
      lineHeight: 18
    }
  ],
  [
    'px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50',
    {
      borderColor: '#242526',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: '#16171880',
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 12,
      paddingBottom: 12,
      borderBottomWidth: 1
    }
  ],
  [
    'px-2 py-1.5 text-xs text-muted-foreground',
    {
      color: '#8a8f98',
      paddingLeft: 8,
      paddingRight: 8,
      paddingTop: 6,
      paddingBottom: 6,
      fontSize: 12,
      lineHeight: 16
    }
  ],
  [
    'px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border',
    {
      backgroundColor: '#16171880',
      display: 'flex',
      justifyContent: 'end',
      gap: 8,
      borderColor: '#242526',
      paddingLeft: 16,
      paddingRight: 16,
      paddingTop: 12,
      paddingBottom: 12,
      borderTopWidth: 1
    }
  ],
  [
    'mt-0.5 text-xs leading-relaxed text-muted-foreground',
    { color: '#8a8f98', marginTop: 2, fontSize: 12, lineHeight: 19.5 }
  ],
  [
    'flex min-w-0 flex-1 items-center gap-1.5',
    {
      display: 'flex',
      minWidth: 0,
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      alignItems: 'center',
      gap: 6
    }
  ],
  [
    'truncate text-sm font-medium text-foreground',
    {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontWeight: 500,
      color: '#e5e5e6',
      fontSize: 14,
      lineHeight: 20
    }
  ],
  ['text-destructive focus:bg-destructive/10 focus:text-destructive', { color: '#ef4444' }],
  [
    'pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground',
    {
      pointerEvents: 'none',
      position: 'absolute',
      display: 'flex',
      alignItems: 'center',
      color: '#8a8f98',
      top: 0,
      bottom: 0,
      paddingLeft: 8,
      paddingRight: 8,
      right: 0
    }
  ],
  [
    'p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors',
    {
      paddingTop: 6,
      paddingRight: 6,
      paddingBottom: 6,
      paddingLeft: 6,
      borderRadius: 4,
      color: '#8a8f98',
      hover: { backgroundColor: '#161718', color: '#e5e5e6' }
    }
  ],
  [
    'inline-flex h-7 w-7 items-center justify-center rounded text-xs font-medium hover:bg-accent',
    {
      display: 'flex',
      height: 28,
      width: 28,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 4,
      fontWeight: 500,
      fontSize: 12,
      lineHeight: 16,
      hover: { backgroundColor: '#246bdd' }
    }
  ],
  [
    'h-full flex flex-col items-center justify-center text-muted-foreground p-8 text-center',
    {
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#8a8f98',
      paddingTop: 32,
      paddingRight: 32,
      paddingBottom: 32,
      paddingLeft: 32,
      textAlign: 'center'
    }
  ],
  [
    'bg-card rounded-lg shadow-2xl w-[480px] border border-border overflow-hidden',
    {
      backgroundColor: '#0f1011',
      borderRadius: 8,
      width: 480,
      borderWidth: 1,
      borderColor: '#242526',
      overflow: 'hidden',
      boxShadow: [
        { offsetX: 0, offsetY: 25, blurRadius: 25, spreadRadius: -12, color: '#00000040' }
      ]
    }
  ],
  [
    'w-80 overflow-hidden rounded-xl border bg-popover p-0 shadow-lg',
    {
      width: 320,
      overflow: 'hidden',
      borderRadius: 12,
      borderWidth: 1,
      backgroundColor: '#161718',
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      boxShadow: [
        { offsetX: 0, offsetY: 4, blurRadius: 3, spreadRadius: -4, color: '#0000001a' },
        { offsetX: 0, offsetY: 10, blurRadius: 7.5, spreadRadius: -3, color: '#0000001a' }
      ],
      borderColor: '#242526'
    }
  ],
  [
    'w-10 h-10 rounded-full bg-secondary flex items-center justify-center mb-3 text-muted-foreground/60',
    {
      width: 40,
      height: 40,
      borderRadius: 9999,
      backgroundColor: '#161718',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#8a8f9899',
      marginBottom: 12
    }
  ],
  [
    'text-xs font-semibold leading-5 text-foreground',
    { fontWeight: 600, color: '#e5e5e6', fontSize: 12, lineHeight: 20 }
  ],
  [
    'text-muted-foreground leading-relaxed text-sm md:text-base mb-8',
    { color: '#8a8f98', marginBottom: 32, fontSize: 16, lineHeight: 26 }
  ],
  [
    'rounded border border-border font-sans text-3xs font-medium text-muted-foreground',
    {
      borderRadius: 4,
      borderWidth: 1,
      borderColor: '#242526',
      fontFamily: 'Inter Variable',
      fontWeight: 500,
      color: '#8a8f98',
      fontSize: 12,
      lineHeight: 18
    }
  ],
  [
    'label-panel flex h-8 w-full items-center gap-1.5 rounded-md pl-1 pr-1.5 hover:bg-foreground/[0.03] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent',
    {
      fontWeight: 500,
      color: '#8a8f98',
      display: 'flex',
      height: 32,
      width: '100%',
      alignItems: 'center',
      gap: 6,
      borderRadius: 6,
      paddingLeft: 4,
      paddingRight: 6,
      fontSize: 12,
      lineHeight: 16.8,
      hover: { backgroundColor: '#e5e5e608', color: '#e5e5e6' },
      focusVisible: {
        outlineWidth: 1,
        outlineColor: '#e5e5e6'
      }
    }
  ],
  [
    'flex-1 flex flex-col min-w-0 rounded-xl border border-border bg-card overflow-clip',
    {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: '#242526',
      backgroundColor: '#0f1011',
      overflow: 'hidden'
    }
  ],
  [
    'w-full max-w-md space-y-5 rounded-xl border border-border bg-card p-5',
    {
      width: '100%',
      maxWidth: 448,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: '#242526',
      backgroundColor: '#0f1011',
      paddingTop: 20,
      paddingRight: 20,
      paddingBottom: 20,
      paddingLeft: 20,
      display: 'flex',
      flexDirection: 'column',
      rowGap: 20
    }
  ],
  [
    'keycap text-foreground',
    {
      backgroundColor: '#1d1e1f',
      boxShadow: [
        { offsetX: 0, offsetY: 1, blurRadius: 1, spreadRadius: 0, color: '#00000040' },
        { offsetX: 0, offsetY: 1, blurRadius: 0, spreadRadius: 0, color: '#e5e5e614', inset: true }
      ],
      color: '#e5e5e6'
    }
  ],
  [
    'bg-primary-fill text-primary-foreground hover:bg-[color-mix(in_oklch,oklch(var(--primary-fill))_85%,black)] disabled:bg-muted disabled:text-disabled-foreground disabled:hover:bg-muted',
    { backgroundColor: '#246bdd', color: '#f5f9ff', hover: { backgroundColor: '#1b55b2' } }
  ],
  [
    'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
    {
      display: 'flex',
      alignItems: 'center',
      borderRadius: 9999,
      borderWidth: 1,
      fontWeight: 600,
      borderColor: '#00000000',
      backgroundColor: '#161718',
      color: '#d0d6e0',
      paddingLeft: 10,
      paddingRight: 10,
      paddingTop: 2,
      paddingBottom: 2,
      fontSize: 12,
      lineHeight: 16,
      hover: { backgroundColor: '#161718cc' }
    }
  ],
  [
    'flex h-10 w-full rounded-lg border border-field-border bg-background px-3 py-2 text-base md:text-sm pointer-coarse:text-base focus-visible:outline-hidden focus-visible:border-ring',
    {
      display: 'flex',
      height: 40,
      width: '100%',
      borderRadius: 8,
      borderWidth: 1,
      borderColor: '#636465',
      backgroundColor: '#08090a',
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 8,
      paddingBottom: 8,
      fontSize: 14,
      lineHeight: 20,
      focusVisible: { outlineWidth: 0, borderColor: '#e5e5e6' }
    }
  ],
  ['data-[state=open]:bg-accent data-[state=open]:text-accent-foreground', {}],
  ['group-hover:text-foreground text-secondary-foreground', { color: '#d0d6e0' }],
  ['p-4 px-2 pt-1', { paddingTop: 4, paddingRight: 8, paddingBottom: 16, paddingLeft: 8 }],
  ['-mt-1 -ml-0.5', { marginTop: -4, marginLeft: -2 }],
  [
    'size-3.5 shrink-0 text-muted-foreground/70',
    { width: 14, height: 14, flexShrink: 0, color: '#8a8f98b3' }
  ],
  ['max-w-3xl mx-auto', { maxWidth: 768 }],
  [
    'grid grid-cols-2 gap-x-4 gap-y-2',
    { display: 'grid', gridTemplateColumns: 2, columnGap: 16, rowGap: 8 }
  ],
  ['line-clamp-2 break-words', { lineClamp: 2, overflow: 'hidden' }],
  [
    'rounded-t-lg rounded-b-none border-x border-t',
    {
      borderTopLeftRadius: 8,
      borderTopRightRadius: 8,
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
      borderLeftWidth: 1,
      borderRightWidth: 1,
      borderTopWidth: 1,
      borderColor: '#242526'
    }
  ],
  [
    'ring-2 ring-primary ring-offset-2 ring-offset-background',
    {
      outlineWidth: 2,
      outlineColor: '#3b82f6',
      outlineOffset: 2
    }
  ],
  [
    'shadow-glow-blue',
    {
      boxShadow: [{ offsetX: 0, offsetY: 0, blurRadius: 7.5, spreadRadius: 0, color: '#3c83f64d' }]
    }
  ],
  [
    'opacity-60 cursor-not-allowed select-none',
    { opacity: 0.6, cursor: 'not-allowed', userSelect: 'none' }
  ],
  ['dark:bg-card bg-background', { backgroundColor: '#0f1011' }],
  ['h-px w-full bg-border', { height: 1, width: '100%', backgroundColor: '#242526' }],
  [
    'absolute -top-1 -right-1 size-2 rounded-full bg-destructive',
    {
      position: 'absolute',
      width: 8,
      height: 8,
      borderRadius: 9999,
      backgroundColor: '#ef4444',
      top: -4,
      right: -4
    }
  ],
  [
    // project-item.tsx: the rail action strip's fade over the diff stat
    'absolute inset-y-0 right-0 bg-gradient-to-l to-transparent pl-6 from-[var(--rail-keycap)] from-60%',
    {
      position: 'absolute',
      top: 0,
      bottom: 0,
      right: 0,
      paddingLeft: 24,
      background: {
        type: 'linear-gradient',
        angle: 270,
        stops: [
          { color: '#1d1e1f', position: 0.6 },
          { color: '#1d1e1f00', position: 1 }
        ],
        colorSpace: 'oklab'
      }
    }
  ],
  [
    // WorkspaceTabBar.tsx: the tab strip's overflow fade
    'absolute right-0 top-0 h-full w-8 bg-gradient-to-l from-card to-transparent pointer-events-none',
    {
      position: 'absolute',
      right: 0,
      top: 0,
      height: '100%',
      width: 32,
      pointerEvents: 'none',
      background: {
        type: 'linear-gradient',
        angle: 270,
        stops: [
          { color: '#0f1011', position: 0 },
          { color: '#0f101100', position: 1 }
        ],
        colorSpace: 'oklab'
      }
    }
  ]
]

describe('tw() on real Termul class strings (termul dark)', () => {
  for (const [classes, expected] of CASES) {
    test(classes, () => {
      expect(tw(classes)).toEqual(expected)
    })
  }
})

describe('tw() state variants', () => {
  const button =
    'bg-primary-fill text-primary-foreground hover:bg-secondary disabled:bg-muted disabled:pointer-events-none'

  test('disabled: replaces the fill, and pointer-events-none drops hover like CSS', () => {
    expect(tw(button, { disabled: true })).toEqual({
      backgroundColor: '#1d1e1f',
      color: '#f5f9ff',
      pointerEvents: 'none'
    })
  })

  test('enabled keeps the native hover style', () => {
    expect(tw(button)).toEqual({
      backgroundColor: '#246bdd',
      color: '#f5f9ff',
      hover: { backgroundColor: '#161718' }
    })
  })

  test('data-[state=open]: applies only for the matching attribute value', () => {
    const trigger = 'text-muted-foreground data-[state=open]:text-foreground data-open:bg-secondary'
    expect(tw(trigger, { attrs: { 'data-state': 'open' } })).toEqual({
      color: '#e5e5e6',
      backgroundColor: '#161718'
    })
    expect(tw(trigger, { attrs: { 'data-state': 'closed' } })).toEqual({ color: '#8a8f98' })
  })

  test('group-hover: follows the group flag and loses to the element hover', () => {
    const name = 'text-secondary-foreground group-hover:text-foreground hover:text-primary'
    expect(tw(name, { groupHover: true })).toEqual({
      color: '#e5e5e6',
      hover: { color: '#3b82f6' }
    })
  })

  test('breakpoints read the viewport width, defaulting to a desktop window', () => {
    expect(tw('text-base md:text-sm', { viewportWidth: 400 })).toEqual({
      fontSize: 16,
      lineHeight: 24
    })
    expect(tw('text-base md:text-sm')).toEqual({ fontSize: 14, lineHeight: 20 })
  })

  test('dark: applies in dark themes only', () => {
    const light = createTw(resolveTwTheme('termul-light'))
    expect(light('bg-background dark:bg-card')).toEqual({ backgroundColor: '#f9f9f9' })
  })
})

describe('tw() flat elevation (termul-light)', () => {
  const light = createTw(resolveTwTheme('termul-light'))

  test('drops shadow-* but keeps rings, as index.css does; an outer ring paints as an outline', () => {
    expect(light('shadow-lg ring-1 ring-border')).toEqual({
      outlineWidth: 1,
      outlineColor: '#e5e5e5'
    })
  })

  test('keepShadow keeps the shadow for buttons and data-keep-shadow', () => {
    expect(light('shadow-sm', { keepShadow: true })).toEqual({
      boxShadow: [
        { offsetX: 0, offsetY: 1, blurRadius: 1, spreadRadius: -1, color: '#0000001a' },
        { offsetX: 0, offsetY: 1, blurRadius: 1.5, spreadRadius: 0, color: '#0000001a' }
      ]
    })
  })
})

describe('tw() bookkeeping', () => {
  test('compiles a string once per theme', () => {
    const classes = 'flex items-center gap-2 px-3'
    expect(tw.compile(classes)).toBe(tw.compile(classes))
  })

  test('records unsupported and unknown classes instead of dropping them silently', () => {
    expect(tw.compile('z-50 flex not-a-utility after:absolute').issues).toEqual([
      {
        token: 'z-50',
        kind: 'unsupported',
        reason: 'z-index: paint order is tree order; use <anchored>'
      },
      { token: 'not-a-utility', kind: 'unknown', reason: 'no utility not-a-utility' },
      {
        token: 'after:absolute',
        kind: 'unsupported',
        reason: 'variant after: selects another element or a pseudo-element'
      }
    ])
  })

  test('calc() over % or viewport units is reported, not painted at a wrong width', () => {
    const compiled = tw.compile(
      'w-[calc(100%-2.75rem)] max-w-[calc(100vw-2rem)] w-[calc(100%+1rem)]'
    )
    expect(compiled.base).toEqual({})
    expect(compiled.issues.map((i) => i.kind)).toEqual(['unknown', 'unknown', 'unknown'])
  })

  test('classifyClass reports each kind', () => {
    expect(classifyClass('px-3')).toEqual({ kind: 'supported' })
    expect(classifyClass('inline-flex')).toEqual({
      kind: 'approximate',
      reason: 'inline-flex lays out as flex'
    })
    expect(classifyClass('transition-colors').kind).toBe('unsupported')
    expect(classifyClass('bg-nonexistent-token')).toEqual({
      kind: 'unknown',
      reason: 'no utility bg-nonexistent-token'
    })
  })
})

describe('tw() divide-*', () => {
  test("SettingsCard's divide-y divide-border is a 1 px border-colour line between rows", () => {
    const compiled = tw.compile(
      '@container flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-card'
    )
    expect(compiled.divide).toEqual({ axis: 'y', width: 1, color: '#242526' })
    expect(compiled.base.borderWidth).toBe(1)
  })

  test('width, axis and colour come from their own classes; the colour defaults to border', () => {
    expect(tw.compile('divide-x-2').divide).toEqual({ axis: 'x', width: 2, color: '#242526' })
    expect(tw.compile('divide-y-[3px] divide-primary/50').divide).toEqual({
      axis: 'y',
      width: 3,
      color: '#3b82f680'
    })
    expect(tw.compile('divide-border').divide).toBeUndefined()
  })

  test('reverse and state-variant divides are reported, not drawn', () => {
    const compiled = tw.compile('divide-y-reverse hover:divide-y')
    expect(compiled.divide).toBeUndefined()
    expect(compiled.issues.map((i) => [i.token, i.kind])).toEqual([
      ['divide-y-reverse', 'unsupported'],
      ['hover:divide-y', 'unsupported']
    ])
  })
})

describe('tw() rings', () => {
  test('a focus ring on a transparent button is an outline, so it never fills the button', () => {
    const style = tw('rounded px-2 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring')
    expect(style.boxShadow).toBeUndefined()
    expect(style.focusVisible).toEqual({ outlineWidth: 1, outlineColor: '#e5e5e6' })
  })

  test('an inset ring stays an inset shadow, and a state can take a ring away', () => {
    expect(tw('ring-1 ring-inset ring-border').boxShadow).toEqual([
      { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 1, color: '#242526', inset: true }
    ])
    expect(tw('ring-2 ring-primary data-[state=open]:ring-0', { attrs: { 'data-state': 'open' } })).toMatchObject({
      outlineWidth: 0
    })
  })
})
