import { describe, expect, it } from 'vitest'
import { cn } from '@/lib/utils'
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_OPTION_ROW_CLASS,
  menuOptionRowClass,
  pickerSearchTextClass
} from './menu-styles'

const classes = (value: string): string[] => value.split(/\s+/).filter(Boolean)

describe('menu-styles', () => {
  it('rows highlight with a foreground wash, never bg-secondary', () => {
    for (const row of [MENU_ITEM_CLASS, MENU_OPTION_ROW_CLASS]) {
      expect(row).toContain('bg-foreground/[0.06]')
      expect(row).not.toContain('bg-secondary')
    }
  })

  it('group label is the shared .label-panel role', () => {
    expect(classes(MENU_LABEL_CLASS)).toContain('label-panel')
  })

  it('option rows are 32px on desktop and 44px touch rows on mobile', () => {
    expect(classes(menuOptionRowClass(false))).toEqual(
      expect.arrayContaining([...classes(MENU_OPTION_ROW_CLASS), 'min-h-8', 'py-1.5'])
    )
    expect(classes(menuOptionRowClass(true))).toEqual(
      expect.arrayContaining([...classes(MENU_OPTION_ROW_CLASS), 'min-h-11', 'py-2.5'])
    )
  })

  it('picker search text is 16px on touch so iOS does not zoom', () => {
    expect(pickerSearchTextClass(true)).toBe('text-base')
    expect(pickerSearchTextClass(false)).toBe('text-xs')
  })

  it('a select shell can drop the shell padding onto its viewport', () => {
    const list = classes(cn(MENU_CONTENT_CLASS, 'p-0'))
    expect(list).toContain('p-0')
    expect(list).not.toContain('p-1')
  })
})
