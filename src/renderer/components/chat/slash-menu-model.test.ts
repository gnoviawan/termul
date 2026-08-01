import { describe, expect, it } from 'vitest'
import type { AvailableCommand, SessionConfigOption, SessionModeState } from '@/lib/acp-api'
import {
  applyCommandToInput,
  buildSlashSections,
  findSlashTrigger,
  isSlashTrigger,
  isSlashTriggerAny,
  type SlashConfigItem,
  type SlashModeItem,
  slashFilter
} from './slash-menu-model'

const commands: AvailableCommand[] = [
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'research', description: 'Deep research' }
]

const configOptions: SessionConfigOption[] = [
  {
    id: 'mode',
    name: 'Session Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'ask',
    description: null,
    options: [
      { value: 'ask', name: 'Ask', description: null },
      { value: 'code', name: 'Code', description: null }
    ]
  },
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'm1',
    description: null,
    options: [
      { value: 'm1', name: 'Sonnet', description: null },
      { value: 'm2', name: 'Opus', description: null }
    ]
  }
]

const modes: SessionModeState = {
  currentModeId: 'ask',
  availableModes: [
    { id: 'ask', name: 'Ask' },
    { id: 'code', name: 'Code' }
  ]
}

describe('slash trigger detection', () => {
  it('opens on a lone slash and a leading slash token', () => {
    expect(isSlashTrigger('/')).toBe(true)
    expect(isSlashTrigger('/com')).toBe(true)
  })
  it('does not open mid-text or with whitespace', () => {
    expect(isSlashTrigger('ab/')).toBe(false)
    expect(isSlashTrigger('/com mand')).toBe(false)
    expect(isSlashTrigger('hello')).toBe(false)
    expect(isSlashTrigger('')).toBe(false)
  })
  it('extracts the filter after the slash', () => {
    expect(slashFilter('/com')).toBe('com')
    expect(slashFilter('/')).toBe('')
  })
  it('applyCommandToInput replaces the slash token', () => {
    expect(applyCommandToInput('/com', 'compact')).toBe('/compact ')
    expect(applyCommandToInput('/', 'research')).toBe('/research ')
  })
})

describe('mid-text slash trigger detection', () => {
  it('findSlashTrigger detects a leading slash token', () => {
    const result = findSlashTrigger('/com')
    expect(result).toEqual({ start: 0, end: 4, filter: 'com' })
  })
  it('findSlashTrigger detects a lone leading slash', () => {
    const result = findSlashTrigger('/')
    expect(result).toEqual({ start: 0, end: 1, filter: '' })
  })
  it('findSlashTrigger detects a mid-text slash after whitespace', () => {
    const result = findSlashTrigger('hello /comp')
    expect(result).toEqual({ start: 6, end: 11, filter: 'comp' })
  })
  it('findSlashTrigger detects a mid-text lone slash after whitespace', () => {
    const result = findSlashTrigger('hello /')
    expect(result).toEqual({ start: 6, end: 7, filter: '' })
  })
  it('findSlashTrigger returns null for slash without preceding whitespace', () => {
    expect(findSlashTrigger('hello/')).toBeNull()
    expect(findSlashTrigger('ab/comp')).toBeNull()
  })
  it('findSlashTrigger returns null for plain text', () => {
    expect(findSlashTrigger('hello')).toBeNull()
    expect(findSlashTrigger('')).toBeNull()
  })
  it('findSlashTrigger respects caret position', () => {
    // Caret is before the token end — should not match
    expect(findSlashTrigger('hello /comp', 8)).toBeNull()
    // Caret is at the token end — should match
    expect(findSlashTrigger('hello /comp', 11)).toEqual({ start: 6, end: 11, filter: 'comp' })
  })

  it('isSlashTriggerAny detects both leading and mid-text triggers', () => {
    expect(isSlashTriggerAny('/')).toBe(true)
    expect(isSlashTriggerAny('/com')).toBe(true)
    expect(isSlashTriggerAny('hello /comp')).toBe(true)
    expect(isSlashTriggerAny('hello /')).toBe(true)
    expect(isSlashTriggerAny('hello/')).toBe(false)
    expect(isSlashTriggerAny('hello')).toBe(false)
    expect(isSlashTriggerAny('')).toBe(false)
  })

  it('slashFilter extracts filter from mid-text triggers', () => {
    expect(slashFilter('hello /comp')).toBe('comp')
    expect(slashFilter('hello /')).toBe('')
    expect(slashFilter('ab/')).toBe('')
  })
})

describe('buildSlashSections', () => {
  it('lists commands first', () => {
    const sections = buildSlashSections({ commands, configOptions: [], modes: null, filter: '' })
    expect(sections[0].id).toBe('commands')
    expect(sections[0].items).toHaveLength(2)
  })

  it('renders one section per config option with category headings', () => {
    const sections = buildSlashSections({ commands: [], configOptions, modes, filter: '' })
    const ids = sections.map((s) => s.id)
    expect(ids).toContain('config:mode')
    expect(ids).toContain('config:model')
    const modeSection = sections.find((s) => s.id === 'config:mode')!
    expect(modeSection.heading).toBe('Mode')
    expect(sections.find((s) => s.id === 'config:model')!.heading).toBe('Model')
  })

  it('PRECEDENCE: omits legacy modes when configOptions exist', () => {
    const sections = buildSlashSections({ commands: [], configOptions, modes, filter: '' })
    expect(sections.find((s) => s.id === 'modes')).toBeUndefined()
  })

  it('falls back to legacy modes only when no configOptions', () => {
    const sections = buildSlashSections({ commands: [], configOptions: [], modes, filter: '' })
    const modeSection = sections.find((s) => s.id === 'modes')
    expect(modeSection).toBeDefined()
    expect(modeSection!.items).toHaveLength(2)
    expect((modeSection!.items[0] as SlashModeItem).kind).toBe('mode')
  })

  it('marks the current config value and mode as selected', () => {
    const cfg = buildSlashSections({ commands: [], configOptions, modes: null, filter: '' })
    const modeItems = cfg.find((s) => s.id === 'config:mode')!.items as SlashConfigItem[]
    expect(modeItems.find((i) => i.valueId === 'ask')!.selected).toBe(true)
    expect(modeItems.find((i) => i.valueId === 'code')!.selected).toBe(false)
  })

  it('filters across commands and option values', () => {
    const sections = buildSlashSections({ commands, configOptions, modes: null, filter: 'opus' })
    // only the model option's "Opus" value matches
    expect(sections.find((s) => s.id === 'commands')).toBeUndefined()
    const model = sections.find((s) => s.id === 'config:model')
    expect(model!.items).toHaveLength(1)
    expect((model!.items[0] as SlashConfigItem).label).toBe('Opus')
  })

  it('returns no sections when everything is empty', () => {
    expect(
      buildSlashSections({ commands: [], configOptions: [], modes: null, filter: '' })
    ).toEqual([])
  })
})
