import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cn } from '@/lib/utils'
import {
  COMPOSER_FOCUS_CLASS,
  FOCUS_RING_CLASS,
  FOCUS_RING_OVERLAY_CLASS,
  PANEL_FIELD_CLASS,
  PANEL_HEADER_CLASS,
  PANEL_ICON_BUTTON_CLASS,
  PROMPT_CARD_FOCUS_CLASS,
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

  it('panel field uses the card fill, the 3:1 field edge and a neutral focus border', () => {
    expect(classes(PANEL_FIELD_CLASS)).toEqual(
      expect.arrayContaining(['bg-card', 'border-field-border', 'focus-visible:border-focus-ring'])
    )
  })

  it('panel field stays 16px on a coarse pointer, including after a caller text-sm', () => {
    expect(classes(PANEL_FIELD_CLASS)).toEqual(
      expect.arrayContaining(['text-xs', 'pointer-coarse:text-base'])
    )
    const merged = classes(cn(PANEL_FIELD_CLASS, 'w-full px-3 py-2 text-sm'))
    expect(merged).toEqual(expect.arrayContaining(['text-sm', 'pointer-coarse:text-base']))
    expect(merged).not.toContain('text-xs')
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

  it('focus styles all paint the --focus-ring token', () => {
    expect(classes(COMPOSER_FOCUS_CLASS)).toEqual([
      'focus-within:border-focus-ring',
      'focus-within:ring-1',
      'focus-within:ring-focus-ring'
    ])
    expect(classes(PROMPT_CARD_FOCUS_CLASS)).toEqual([
      'has-[:focus-visible]:border-focus-ring',
      'has-[:focus-visible]:ring-1',
      'has-[:focus-visible]:ring-focus-ring'
    ])
    expect(classes(FOCUS_RING_OVERLAY_CLASS)).toEqual(
      expect.arrayContaining([
        'focus-visible:outline-hidden',
        'focus-visible:after:ring-2',
        'focus-visible:after:ring-inset',
        'focus-visible:after:ring-focus-ring'
      ])
    )
  })

  it.each([
    ['components/chat/ChatInputBar.tsx', 'COMPOSER_FOCUS_CLASS'],
    ['components/agents/AgentLauncher.tsx', 'COMPOSER_FOCUS_CLASS'],
    ['components/chat/AskUserQuestion.tsx', 'PROMPT_CARD_FOCUS_CLASS'],
    ['components/chat/ElicitationPrompt.tsx', 'COMPOSER_FOCUS_CLASS']
  ])('%s takes the shared %s, not a faint one-off ring', (file, focusClass) => {
    const source = readFileSync(join(__dirname, '../..', file), 'utf8')
    expect(source).toContain(focusClass)
    expect(source).not.toMatch(/focus-within:ring-foreground\//)
  })
})
