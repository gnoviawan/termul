import { describe, expect, it } from 'vitest'
import type { SessionConfigOption, SessionModeState } from '@/lib/acp-api'
import {
  filterDuplicateModeConfigOptions,
  modesRedundantWithThoughtLevel,
  partitionConfigOptions,
  shouldAdvertiseConfigOption
} from './chat-input-bar-config'

function opt(id: string, category: string | null): SessionConfigOption {
  return {
    id,
    name: id,
    category,
    type: 'select',
    currentValue: 'a',
    description: null,
    options: [
      { value: 'a', name: 'A', description: null },
      { value: 'b', name: 'B', description: null }
    ]
  }
}

describe('partitionConfigOptions', () => {
  it('returns null thoughtLevel and empty rest for no options', () => {
    expect(partitionConfigOptions([])).toEqual({ model: null, thoughtLevel: null, rest: [] })
  })

  it('promotes a thought_level option and leaves rest empty', () => {
    const tl = opt('reasoning', 'thought_level')
    const result = partitionConfigOptions([tl])
    expect(result.model).toBeNull()
    expect(result.thoughtLevel).toBe(tl)
    expect(result.rest).toEqual([])
  })

  it('promotes a model option and keeps generic options in rest', () => {
    const mode = opt('mode', 'mode')
    const model = opt('model', 'model')
    const result = partitionConfigOptions([mode, model])
    expect(result.model).toBe(model)
    expect(result.thoughtLevel).toBeNull()
    expect(result.rest).toEqual([mode])
  })

  it('partitions mixed options, preserving rest order', () => {
    const mode = opt('mode', 'mode')
    const tl = opt('reasoning', 'thought_level')
    const model = opt('model', 'model')
    const result = partitionConfigOptions([mode, tl, model])
    expect(result.model).toBe(model)
    expect(result.thoughtLevel).toBe(tl)
    expect(result.rest).toEqual([mode])
  })

  it('treats unknown categories as generic rest', () => {
    const custom = opt('custom', 'something-new')
    const result = partitionConfigOptions([custom])
    expect(result.model).toBeNull()
    expect(result.thoughtLevel).toBeNull()
    expect(result.rest).toEqual([custom])
  })

  it('promotes only the first thought_level option and discards later duplicates', () => {
    const tl1 = opt('reasoning1', 'thought_level')
    const tl2 = opt('reasoning2', 'thought_level')
    const result = partitionConfigOptions([tl1, tl2])
    expect(result.model).toBeNull()
    expect(result.thoughtLevel).toBe(tl1)
    expect(result.rest).toEqual([])
  })

  it('promotes only the first model option and discards later duplicates', () => {
    const model1 = opt('model1', 'model')
    const model2 = opt('model2', 'model')
    const result = partitionConfigOptions([model1, model2])
    expect(result.model).toBe(model1)
    expect(result.thoughtLevel).toBeNull()
    expect(result.rest).toEqual([])
  })

  it('keeps non-singleton categories in rest alongside promoted chips', () => {
    const model1 = opt('model1', 'model')
    const model2 = opt('model2', 'model')
    const tl1 = opt('reasoning1', 'thought_level')
    const tl2 = opt('reasoning2', 'thought_level')
    const custom = opt('custom', 'something-new')
    const result = partitionConfigOptions([model1, tl1, custom, model2, tl2])
    expect(result.model).toBe(model1)
    expect(result.thoughtLevel).toBe(tl1)
    expect(result.rest).toEqual([custom])
  })
})

describe('shouldAdvertiseConfigOption', () => {
  it('accepts the first promoted singleton and rejects later ones', () => {
    const seen = new Set<string>()
    expect(shouldAdvertiseConfigOption(opt('tl1', 'thought_level'), seen)).toBe(true)
    expect(shouldAdvertiseConfigOption(opt('tl2', 'thought_level'), seen)).toBe(false)
    expect(shouldAdvertiseConfigOption(opt('model1', 'model'), seen)).toBe(true)
    expect(shouldAdvertiseConfigOption(opt('model2', 'model'), seen)).toBe(false)
  })

  it('always accepts uncategorized and non-singleton options', () => {
    const seen = new Set<string>(['thought_level'])
    expect(shouldAdvertiseConfigOption(opt('mode', 'mode'), seen)).toBe(true)
    expect(shouldAdvertiseConfigOption(opt('custom', null), seen)).toBe(true)
  })
})

describe('filterDuplicateModeConfigOptions', () => {
  const modes: SessionModeState = {
    currentModeId: 'agent',
    availableModes: [
      { id: 'agent', name: 'Agent' },
      { id: 'plan', name: 'Plan' }
    ]
  }

  it('keeps mode config options when native modes are absent', () => {
    const mode = opt('mode', 'mode')
    expect(filterDuplicateModeConfigOptions([mode], null)).toEqual([mode])
  })

  it('removes mode config options when native modes are present', () => {
    const mode = opt('mode', 'mode')
    const custom = opt('custom', 'custom')
    expect(filterDuplicateModeConfigOptions([mode, custom], modes)).toEqual([custom])
  })
})

describe('modesRedundantWithThoughtLevel', () => {
  const thoughtLevel: SessionConfigOption = {
    id: 'thought_level',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'off',
    description: null,
    options: [
      { value: 'off', name: 'Thinking: off', description: null },
      { value: 'low', name: 'Thinking: low', description: null },
      { value: 'medium', name: 'Thinking: medium', description: null }
    ]
  }

  it('detects pi-acp dual-published thinking modes', () => {
    const modes: SessionModeState = {
      currentModeId: 'off',
      availableModes: [
        { id: 'off', name: 'Thinking: off' },
        { id: 'low', name: 'Thinking: low' },
        { id: 'medium', name: 'Thinking: medium' }
      ]
    }
    expect(modesRedundantWithThoughtLevel(modes, thoughtLevel)).toBe(true)
  })

  it('keeps real agent/plan modes alongside thought_level', () => {
    const modes: SessionModeState = {
      currentModeId: 'agent',
      availableModes: [
        { id: 'agent', name: 'Agent' },
        { id: 'plan', name: 'Plan' }
      ]
    }
    expect(modesRedundantWithThoughtLevel(modes, thoughtLevel)).toBe(false)
  })

  it('returns false when either side is missing', () => {
    expect(modesRedundantWithThoughtLevel(null, thoughtLevel)).toBe(false)
    expect(
      modesRedundantWithThoughtLevel(
        { currentModeId: 'off', availableModes: [{ id: 'off', name: 'Thinking: off' }] },
        null
      )
    ).toBe(false)
  })
})
