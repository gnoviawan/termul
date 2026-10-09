import { describe, expect, it } from 'vitest'
import { cn } from '@/lib/utils'
import {
  FOCUS_RING_CLASS,
  PANEL_FIELD_CLASS,
  PANEL_HEADER_CLASS,
  PANEL_ICON_BUTTON_CLASS,
  pressedToggleClass,
  QUIET_ICON_BUTTON_CLASS,
  SEGMENTED_TRACK_CLASS,
  segmentClass
} from './panel-styles'

const classes = (value: string): string[] => value.split(/\s+/).filter(Boolean)

describe('panel-styles', () => {
  it('quiet icon button carries the neutral hover wash and focus ring, no size', () => {
    const list = classes(QUIET_ICON_BUTTON_CLASS)
    expect(list).toEqual(
      expect.arrayContaining([
        'hover:bg-foreground/[0.03]',
        'hover:text-foreground',
        ...classes(FOCUS_RING_CLASS)
      ])
    )
    expect(list.some((c) => c.startsWith('size-'))).toBe(false)
  })

  it('panel icon button is the quiet button at 28px', () => {
    expect(PANEL_ICON_BUTTON_CLASS).toBe(`${QUIET_ICON_BUTTON_CLASS} size-7`)
  })

  it('call sites can override height on the shared header and display on the button', () => {
    expect(classes(cn(PANEL_HEADER_CLASS, 'h-9'))).toContain('h-9')
    expect(classes(cn(PANEL_HEADER_CLASS, 'h-9'))).not.toContain('h-10')
    const flexButton = classes(cn(QUIET_ICON_BUTTON_CLASS, 'flex size-6'))
    expect(flexButton).toContain('flex')
    expect(flexButton).not.toContain('inline-flex')
  })

  it('panel field uses the card fill and a neutral focus border', () => {
    expect(classes(PANEL_FIELD_CLASS)).toEqual(
      expect.arrayContaining(['bg-card', 'border-border', 'focus:border-muted-foreground/60'])
    )
  })

  it('segmented track uses the card fill with a 2px inset', () => {
    expect(classes(SEGMENTED_TRACK_CLASS)).toEqual(
      expect.arrayContaining(['bg-card', 'border-border', 'p-0.5'])
    )
  })

  it('active segment takes the keycap, inactive stays muted with a hover lift', () => {
    expect(classes(segmentClass(true))).toEqual(
      expect.arrayContaining(['keycap', 'text-foreground', ...classes(FOCUS_RING_CLASS)])
    )
    expect(classes(segmentClass(true))).not.toContain('text-muted-foreground')
    expect(classes(segmentClass(false))).toEqual(
      expect.arrayContaining(['text-muted-foreground', 'hover:text-foreground'])
    )
    expect(classes(segmentClass(false))).not.toContain('keycap')
  })

  it('pressed toggle is a foreground wash, idle stays muted with a hover lift', () => {
    expect(classes(pressedToggleClass(true))).toEqual(
      expect.arrayContaining(['border-border', 'bg-foreground/10', 'text-foreground'])
    )
    expect(classes(pressedToggleClass(true))).not.toContain('keycap')
    expect(classes(pressedToggleClass(false))).toEqual(
      expect.arrayContaining([
        'border-border',
        'text-muted-foreground',
        'hover:bg-foreground/[0.03]'
      ])
    )
  })
})
